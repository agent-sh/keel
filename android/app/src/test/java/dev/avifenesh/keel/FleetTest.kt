package dev.avifenesh.keel

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The phone's view of the fleet: the Errors list kept from the stream, the lasting notification's words and where
// its tap leads, where a failure's notification leads, and a landing card's lines.
class FleetTest {
    private fun row(id: String, last: Double, read: Boolean = false, recovered: Boolean = false) =
        ErrorRow(id, "m-$id", "provider", 1, last, last, read, recovered)

    @Test fun theErrorsListFollowsTheStreamWithoutAReadOfTheList() {
        val l = ErrorList(listOf(row("a", 300.0), row("b", 200.0, read = true)), 1)
        // b happened again: unread, and first as the newest.
        val again = l.changed(row("b", 400.0), gone = false)
        assertEquals(listOf("b", "a"), again.rows.map { it.id })
        assertEquals(2, again.unread)
        // a was read on the page: in place, out of the count.
        val read = again.changed(row("a", 300.0, read = true), gone = false)
        assertEquals(listOf("b", "a"), read.rows.map { it.id })
        assertEquals(1, read.unread)
        // A new kind comes first; a resolved one goes.
        val fresh = read.changed(row("c", 500.0), gone = false).changed(row("b", 400.0), gone = true)
        assertEquals(listOf("c", "a"), fresh.rows.map { it.id })
        assertEquals(1, fresh.unread)
        // Healed by a retry: listed, not counted.
        assertEquals(0, ErrorList(emptyList(), 0).changed(row("d", 1.0, recovered = true), gone = false).unread)
        // A frame is read whole, or not at all.
        val (r, gone) = ErrorList.frame(JSONObject().put("type", "error_changed").put("gone", true).put("row", JSONObject().put("id", "x").put("message", "boom").put("last", 9)))!!
        assertEquals(listOf("x", "boom", true), listOf(r.id, r.message, gone))
        assertNull(ErrorList.frame(JSONObject().put("type", "error_changed")))
    }

    @Test fun theLastingNotificationCountsErrorsBesideWorkAndLeadsToWhatAsksFirst() {
        val chats = mapOf("s1" to Chat("s1", "Fix the build", "working", 0.0, 0, false, false, "", "", null), "s2" to Chat("s2", "Docs", "idle", 0.0, 0, false, false, "", "", null))
        val l = Live.of(mapOf("s1" to 100.0), emptyList(), chats, unreadErrors = 3)
        assertEquals(listOf("1 session working · 3 errors", "Fix the build", "errors", 3), listOf(l.title, l.body, l.to, l.failed))
        // Nothing runs or waits: no notification, and errors alone put none up.
        val idle = Live.of(emptyMap(), emptyList(), chats, unreadErrors = 3)
        assertEquals(listOf(false, 0, "sessions"), listOf(idle.shown, idle.failed, idle.to))
        assertEquals(listOf("sessions", "needs", "needs", "errors"), listOf(Live.to(0, 0), Live.to(1, 0), Live.to(2, 5), Live.to(0, 1)))
        // The daemon's push says it all; one from before `to` leads by its counts.
        val pushed = Live.of(PushMsg.of(mapOf("t" to "live", "w" to "2", "q" to "1", "f" to "4", "to" to "needs", "title" to "2 sessions working · 1 needs you · 4 errors")))
        assertEquals(listOf(2, 1, 4, "needs"), listOf(pushed.working, pushed.needs, pushed.failed, pushed.to))
        assertEquals("errors", Live.of(PushMsg.of(mapOf("t" to "live", "w" to "1", "f" to "2"))).to)
        // Swiped away: not posted again while the work goes on; when nothing runs or waits, the next work gets it.
        assertEquals(true to false, Live.gate(l, swiped = false))
        assertEquals(false to true, Live.gate(l.copy(working = 3), swiped = true))
        assertEquals(false to false, Live.gate(idle, swiped = true))
    }

    @Test fun aNotificationThatNamesNoSessionLeadsToItsList() {
        assertEquals("errors", PushMsg.of(mapOf("t" to "outage", "c" to "", "open" to "errors")).open)
        assertEquals("", PushMsg.of(mapOf("t" to "failed", "c" to "s1")).open)
        assertEquals(listOf(Route.Tabs(1), Route.Errors, Route.Tabs(0), Route.Tabs(0)), listOf(Route.of("needs"), Route.of("errors"), Route.of("sessions"), Route.of("")))
    }

    @Test fun aLandingCardSaysItsEvidenceInLines() {
        val o = JSONObject("""{"key":"s-root.ag1","chat_id":"s-root","title":"Mobile round","agent_chat":"s-ag1","agent_title":"Fix the retry","agent_state":"completed",
            "branch":"keel/fix-retry","base":"main","head":"3f2a9c1d0b7e4a5f8c6d","ahead":2,"behind":1,
            "checks":{"state":"known","passed":["typecheck","unit"],"failed":["e2e"],"not_run":["smoke"]},
            "review":{"verdict":"approved","by":"rv1","title":"Review the fix","line":"Bounded.","current":false},
            "proof":"(Checks after its last edit: unit passed.)","areas":[{"area":"src/","files":3,"added":84,"removed":12},{"area":"README.md","files":1,"added":1,"removed":0}],
            "queue":{"state":"left","why":"e2e failed"},"ready":false,"missing":["failed: e2e"],"fp":"p1"}""")
        val c = LandCard.of(o)
        assertEquals("3f2a9c1d0", c.short)
        assertEquals("2 ahead · 1 behind main", c.against)
        assertEquals("typecheck, unit passed · e2e failed · smoke not run", c.checksLine)
        assertEquals("Approved an older head", c.reviewLineShort)
        assertEquals("Approved by Review the fix", LandCard.of(JSONObject(o.toString()).put("review", JSONObject(o.getJSONObject("review").toString()).put("current", true))).reviewLineShort)
        assertEquals("src/ 3 files +84 −12 · README.md 1 file +1 −0", c.size)
        assertEquals(listOf("left", "e2e failed", false), listOf(c.queueState, c.queueWhy, c.reviewCurrent))
        val bare = LandCard.of(JSONObject(o.toString()).put("review", JSONObject.NULL).put("checks", JSONObject().put("state", "unknown").put("why", "no worktree")).put("ahead", JSONObject.NULL).put("behind", 0))
        assertEquals(listOf("No review", "Checks not known: no worktree", ""), listOf(bare.reviewLineShort, bare.checksLine, bare.against))
        assertEquals("The repository names no checks", LandCard.of(JSONObject(o.toString()).put("checks", JSONObject().put("state", "none"))).checksLine)
        assertEquals(listOf("s-root.ag1"), LandCard.list(JSONObject().put("cards", JSONArray().put(o))).map { it.key })
        // A refusal carries the card as it is now, or none when it no longer waits.
        val refused = LandOutcome.refused(JSONObject().put("error", "Its facts changed").put("card", o))
        assertEquals(listOf(false, "Its facts changed", "p1"), listOf(refused.ok, refused.error, refused.card?.fp))
        assertNull(LandOutcome.refused(JSONObject().put("error", "gone").put("card", JSONObject.NULL)).card)
        val ok = LandOutcome.of(JSONObject().put("entry", JSONObject().put("id", "lq-1").put("state", "queued")).put("warnings", JSONArray()).put("card", o))
        assertEquals(listOf(true, "lq-1", "queued"), listOf(ok.ok, ok.entry, ok.state))
    }
}
