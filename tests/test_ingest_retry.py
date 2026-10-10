"""Rate limits during ingest: every model step is owed a retry, and a retry only pays
for the steps that did not finish."""

from __future__ import annotations

import uuid

import httpx
import openai
import pytest

from enqueue import db
from enqueue.ingest import entities as entities_mod
from enqueue.ingest import queue as q
from enqueue.ingest import source
from enqueue.providers.base import ProviderError, is_transient


def _rate_limited() -> ProviderError:
    response = httpx.Response(429, request=httpx.Request("POST", "http://model.test/v1"))
    try:
        raise openai.RateLimitError("slow down", response=response, body=None)
    except openai.RateLimitError as exc:
        try:
            raise ProviderError("the endpoint is rate limiting") from exc
        except ProviderError as wrapped:
            return wrapped


def _retry_row(aid):
    conn = db.get_conn()
    try:
        return conn.execute("SELECT * FROM facet_retry WHERE artifact_id = ?", (aid,)).fetchone()
    finally:
        conn.close()


class _Provider:
    name = "fake"
    model = "ingest-model"

    def __init__(self, replies):
        self.replies = replies
        self.calls: list[str] = []

    def complete(self, system, user, response_model, context=None, max_retries=None):
        self.calls.append(response_model.__name__)
        reply = self.replies(response_model, user)
        if isinstance(reply, Exception):
            raise reply
        return response_model(**reply)


@pytest.fixture
def provider(store, monkeypatch):
    import enqueue.providers.base as base_mod

    holder = {}

    def use(replies):
        holder["p"] = _Provider(replies)
        return holder["p"]

    monkeypatch.setattr(base_mod, "get_provider", lambda **kw: holder["p"])
    return use


def _note(body: str) -> str:
    aid = str(uuid.uuid4())
    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO artifacts (id, kind, title, body, content_hash, status, created_at,"
            " updated_at) VALUES (?, 'note', 'Notes', ?, ?, 'ok', ?, ?)",
            (aid, body, aid, db.now(), db.now()),
        )
    return aid


def test_rate_limits_and_outages_are_transient_bad_output_is_not():
    assert is_transient(_rate_limited())
    assert not is_transient(ProviderError("the model returned something that failed validation"))


def test_a_rate_limited_section_is_owed_not_replaced_by_the_opening(provider):
    provider(lambda model, user: _rate_limited())
    aid = _note("\n\n".join(f"Paragraph {i}. " + "words " * 400 for i in range(40)))

    conn = db.get_conn()
    try:
        with pytest.raises(source.SummariesOwed):
            source.ingest_text(conn, aid)
    finally:
        conn.close()

    q._sections_artifact(aid)
    assert _retry_row(aid) is not None


def test_a_rate_limit_while_enriching_entities_is_owed(provider):
    provider(
        lambda model, user: (
            {"entities": [{"name": "Nassim Taleb"}]}
            if model.__name__ == "_RawEntitySet"
            else _rate_limited()
        )
    )
    aid = _note("Nassim Taleb wrote about fragility.")

    conn = db.get_conn()
    try:
        count, error = entities_mod.generate_for_artifact(conn, aid)
    finally:
        conn.close()

    assert count == 0 and isinstance(error, source.Owed)
    q._entities_artifact(aid)
    assert _retry_row(aid) is not None


def test_a_bad_entity_line_is_dropped_not_retried(provider):
    provider(
        lambda model, user: (
            {"entities": [{"name": "Nassim Taleb"}]}
            if model.__name__ == "_RawEntitySet"
            else {"facts": [{"name": "Nassim Taleb", "fact": "too short"}]}
        )
    )
    aid = _note("Nassim Taleb wrote about fragility.")

    assert q._entities_artifact(aid) == 0
    assert _retry_row(aid) is None


def test_a_retry_only_asks_for_the_contexts_that_are_missing(provider):
    from enqueue.ingest.chunk import chunk_artifact

    aid = _note("\n\n".join(f"## Part {i}\n\n" + f"Detail {i}. " * 150 for i in range(4)))
    with db.transaction() as conn:
        assert chunk_artifact(conn, aid) >= 4

    seen: list[str] = []

    def replies(model, user):
        listing = user.split("Chunks:")[1]
        n = listing.count("\n[") + 1
        seen.append(listing)
        if len(seen) == 1:
            return _rate_limited()
        return {
            "contexts": [
                {"index": i, "context": f"Part of the notes ({i})."} for i in range(1, n + 1)
            ]
        }

    provider(replies)
    q._context_artifact(aid)
    assert _retry_row(aid) is not None  # the whole batch was rate limited

    q._context_artifact(aid)  # the retry writes them
    first_pass = seen[-1].count("\n[") + 1
    q._context_artifact(aid)  # nothing missing: no model call
    assert len(seen) == 2 and first_pass >= 4

    with db.transaction() as conn:  # a reprocess re-chunks: contexts carry over
        chunk_artifact(conn, aid)
        missing = conn.execute(
            "SELECT COUNT(*) AS n FROM chunks WHERE artifact_id = ? AND context IS NULL",
            (aid,),
        ).fetchone()["n"]
    assert missing == 0


def test_current_facets_and_entities_cost_nothing_on_a_retry(provider):
    from enqueue.ingest import facets as facets_mod

    aid = _note("A body long enough to earn facets and entities from the model.")
    p = provider(lambda model, user: _rate_limited())
    with db.transaction() as conn:
        for table, cols in (
            ("facets", "(id, artifact_id, level, statement, model_version, trust)"),
            ("entities", "(id, artifact_id, entity, fact, model_version, trust)"),
        ):
            conn.execute(
                f"INSERT INTO {table} {cols} VALUES (?, ?, ?, ?, 'ingest-model', 0.5)",
                (f"{table}-1", aid, 1 if table == "facets" else "X", "A line of text here."),
            )
    conn = db.get_conn()
    try:  # no versions and a NULL body_version on both: current
        assert facets_mod.is_current(conn, aid) and entities_mod.is_current(conn, aid)
    finally:
        conn.close()

    assert q._facet_artifact(aid) == 0
    assert q._entities_artifact(aid) == 0
    assert p.calls == []


def test_a_clean_run_clears_what_was_owed(provider, monkeypatch):
    aid = _note("Short.")
    with db.transaction() as conn:
        q._record_facet_retry(conn, aid, "earlier rate limit")
    for step in ("_sections_artifact", "_facet_artifact", "_entities_artifact"):
        monkeypatch.setattr(q, step, lambda _aid: 0)
    provider(lambda model, user: {})

    q.process(aid)

    assert _retry_row(aid) is None


def test_a_run_that_still_owes_keeps_the_row(provider, monkeypatch):
    aid = _note("Short.")
    for step in ("_sections_artifact", "_entities_artifact"):
        monkeypatch.setattr(q, step, lambda _aid: 0)

    def owe(_aid):
        conn = db.get_conn()
        try:
            q._record_facet_retry(conn, _aid, "rate limited")
            conn.commit()
        finally:
            conn.close()
        return 0

    monkeypatch.setattr(q, "_facet_artifact", owe)
    provider(lambda model, user: {})

    q.process(aid)

    assert _retry_row(aid) is not None


def _due(aid: str) -> None:
    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO facet_retry (artifact_id, attempts, next_at, last_error)"
            " VALUES (?, 0, '2000-01-01T00:00:00+00:00', 'SummariesOwed: paused')",
            (aid,),
        )


def _quiet_steps(monkeypatch, during=None):
    """No model step has anything to do; `during` runs in the middle of the run."""
    for step in ("_sections_artifact", "_facet_artifact"):
        monkeypatch.setattr(q, step, lambda _aid: 0)
    monkeypatch.setattr(q, "_entities_artifact", lambda _aid: during() if during else 0)


def test_a_sweep_during_a_retry_run_does_not_queue_it_again(provider, monkeypatch):
    # The live loop: a long document's run outlasts the 30s sweep. The sweeper saw a due
    # row and nothing queued (the worker had taken the item), queued a second copy, and
    # the run then left the row alone because a newer copy was waiting. Forever.
    import threading

    aid = _note("A long document whose run takes longer than one sweep.")
    _due(aid)
    provider(lambda model, user: {})
    monkeypatch.setattr(q, "submit_background", q._queue)
    swept: list[list[str]] = []

    def sweep():  # the sweeper has its own thread
        t = threading.Thread(target=lambda: swept.append(q._sweep_due()))
        t.start()
        t.join()
        return 0

    _quiet_steps(monkeypatch, during=sweep)
    q._dequeue(aid, q._queue(aid))  # what the worker does before the run
    try:
        q.process(aid)
        assert swept == [[]]
        assert _retry_row(aid) is None
    finally:
        q._queued.pop(aid, None)
        del q._running.item


def test_a_run_never_leaves_a_retry_due_in_the_past(provider, monkeypatch):
    from datetime import datetime, timezone

    aid = _note("An edit lands while the retry runs.")
    _due(aid)
    provider(lambda model, user: {})
    _quiet_steps(monkeypatch, during=lambda: q._queue(aid) and 0)  # a newer copy is queued
    q._dequeue(aid, q._queue(aid))
    try:
        q.process(aid)
        row = _retry_row(aid)  # the newer copy settles it; until then it is not due
        assert row is not None and row["next_at"] > datetime.now(timezone.utc).isoformat()
        assert q._sweep_due() == []
    finally:
        q._queued.pop(aid, None)
        del q._running.item


def test_a_failed_run_does_not_leave_the_retry_due(provider, monkeypatch):
    from datetime import datetime, timezone

    aid = _note("The database is busy.")
    _due(aid)

    def locked(_aid):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(q, "_process", locked)
    with pytest.raises(RuntimeError):
        q.process(aid)

    assert _retry_row(aid)["next_at"] > datetime.now(timezone.utc).isoformat()


def _chunk_ids(aid):
    conn = db.get_conn()
    try:
        return [
            r["id"]
            for r in conn.execute(
                "SELECT id FROM chunks WHERE artifact_id = ? ORDER BY ordinal", (aid,)
            )
        ]
    finally:
        conn.close()


def test_a_retry_does_not_rechunk_or_reembed_unchanged_text(provider, monkeypatch):
    from enqueue import events
    from enqueue.index import store_sqlite

    aid = _note("\n\n".join(f"## Part {i}\n\n" + f"Detail {i}. " * 150 for i in range(3)))
    provider(lambda model, user: {})
    _quiet_steps(monkeypatch)
    monkeypatch.setattr(q, "_context_artifact", lambda _aid: 0)
    first = q.process(aid)
    ids = _chunk_ids(aid)
    assert first["chunks"] == len(ids) >= 3

    embedded: list[int] = []
    real = store_sqlite.embed
    monkeypatch.setattr(
        store_sqlite, "embed", lambda texts: embedded.append(len(texts)) or real(texts)
    )
    logged = len([e for e in events.recent(50) if e["kind"] == "ingest"])

    again = q.process(aid)

    assert again["chunks"] == len(ids) and _chunk_ids(aid) == ids
    assert embedded == []
    assert len([e for e in events.recent(50) if e["kind"] == "ingest"]) == logged

    with db.transaction() as conn:  # the title is index text: a rename is re-indexed
        conn.execute("UPDATE artifacts SET title = 'Renamed' WHERE id = ?", (aid,))
    q.process(aid)
    assert embedded == [len(ids)]

    with db.transaction() as conn:  # and so is a body that changed
        conn.execute("UPDATE artifacts SET body = body || '\n\nA new ending.' WHERE id = ?", (aid,))
    q.process(aid)
    assert _chunk_ids(aid) != ids and len(embedded) == 2
