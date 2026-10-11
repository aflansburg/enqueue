"""A link's title before (or without) a preview: the article's words, not its address.

A publisher that refuses the preview (Medium) left links titled
"the end of prestige ... 0b96b649edf4 - medium.com" for good.
"""

from __future__ import annotations

import pytest

from enqueue import capture, db

MEDIUM = "https://medium.com/design-bootcamp/the-end-of-prestige-how-ai-0b96b649edf4"


@pytest.mark.parametrize(
    ("url", "title"),
    [
        (MEDIUM, "The end of prestige how ai"),
        (
            "https://steve-yegge.medium.com/the-anthropic-hive-mind-d01f768f3d7b",
            "The anthropic hive mind",
        ),
        ("https://elion.health/resources/guide-interoperability", "Guide interoperability"),
        ("https://example.com/posts/top_10_tools.html", "Top 10 tools"),
        # A year or a count at the end of a slug is part of the title, not an id.
        ("https://example.com/state-of-ai-2025", "State of ai 2025"),
        ("https://example.com/a-decade-of-added-facade", "A decade of added facade"),
        # Nothing in the address names the page: the site does.
        ("https://www.airdna.co/", "airdna.co"),
        ("https://docs.google.com/document/d/1PMmr8dQY/edit", "docs.google.com"),
        (
            "https://www.sciencedirect.com/science/article/abs/pii/S1877750316304471",
            "sciencedirect.com",
        ),
    ],
)
def test_title_from_url(url, title):
    assert capture.title_from_url(url) == title


def test_older_placeholders_are_still_known_as_placeholders():
    assert capture.is_placeholder_title(
        "the end of prestige how ai 0b96b649edf4 - medium.com", MEDIUM
    )
    assert capture.is_placeholder_title(MEDIUM, MEDIUM)  # the phone saves the bare address
    assert capture.is_placeholder_title("The end of prestige how ai", MEDIUM)
    assert not capture.is_placeholder_title("The End of Prestige", MEDIUM)


def _title(artifact_id: str) -> tuple[str, str]:
    conn = db.get_conn()
    try:
        row = conn.execute(
            "SELECT title, updated_at FROM artifacts WHERE id = ?", (artifact_id,)
        ).fetchone()
        return row["title"], row["updated_at"]
    finally:
        conn.close()


def test_retitle_cleans_old_placeholders_and_nothing_else(store, quiet_queue):
    old = capture.link(MEDIUM)["id"]
    named = capture.link("https://example.com/a-b-c", title="What the page is called")["id"]
    renamed = capture.link("https://example.com/d-e-f")["id"]
    with db.transaction() as conn:
        conn.execute(
            "UPDATE artifacts SET title = ? WHERE id = ?",
            ("the end of prestige how ai 0b96b649edf4 - medium.com", old),
        )
        conn.execute(
            "UPDATE artifacts SET title = 'Mine', title_explicit = 1 WHERE id = ?", (renamed,)
        )
    before = _title(old)[1]

    assert capture.retitle_placeholders() == 1
    assert _title(old) == ("The end of prestige how ai", before)  # order on the wall kept
    assert _title(named)[0] == "What the page is called"
    assert _title(renamed)[0] == "Mine"
    assert capture.retitle_placeholders() == 0


def test_a_preview_still_replaces_an_old_placeholder(store, quiet_queue, monkeypatch):
    from enqueue import preview

    aid = capture.link(MEDIUM)["id"]
    with db.transaction() as conn:
        conn.execute(
            "UPDATE artifacts SET title = ? WHERE id = ?",
            ("the end of prestige how ai 0b96b649edf4 - medium.com", aid),
        )
    page = "<html><head><title>The End of Prestige</title></head><body><p>x</p></body></html>"
    monkeypatch.setattr(preview, "_read_capped", lambda url: ("text/html", page))

    preview.fetch(aid)

    assert _title(aid)[0] == "The End of Prestige"
