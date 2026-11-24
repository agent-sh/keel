package dev.avifenesh.keel

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The phone's view of the fleet: the Errors list kept from the stream, and where a failure's notification leads.
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

    @Test fun aNotificationThatNamesNoSessionLeadsToItsList() {
        assertEquals("errors", PushMsg.of(mapOf("t" to "outage", "c" to "", "open" to "errors")).open)
        assertEquals("", PushMsg.of(mapOf("t" to "failed", "c" to "s1")).open)
        assertEquals(listOf(Route.Errors, Route.Tabs(0), Route.Tabs(0)), listOf(Route.of("errors"), Route.of("sessions"), Route.of("")))
    }
}
