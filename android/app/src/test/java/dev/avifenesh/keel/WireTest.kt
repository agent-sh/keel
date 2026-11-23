package dev.avifenesh.keel

import dev.avifenesh.keel.ui.Block
import dev.avifenesh.keel.ui.blocks
import dev.avifenesh.keel.ui.MathRun
import dev.avifenesh.keel.ui.inline
import dev.avifenesh.keel.ui.inlineMath
import dev.avifenesh.keel.ui.mathRuns
import dev.avifenesh.keel.ui.mathText
import androidx.compose.ui.text.SpanStyle
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Pure logic of the app. What it shares with the daemon (signed bytes, shapes) is in ContractTest.
class WireTest {
    @Test fun aSendKeepsItsIdForTheSameWords() {
        var n = 0
        val fresh = { "id-${++n}" }
        val first = Wire.sendId("", "", "ship it", fresh)
        assertEquals("id-1", first)
        // The answer was lost: the same words go under the same id.
        assertEquals("id-1", Wire.sendId(first, "ship it", "ship it", fresh))
        // Other words are another send.
        assertEquals("id-2", Wire.sendId(first, "ship it", "ship it now", fresh))
        val body = Wire.sendBody("ship it", "steer", first)
        assertEquals(listOf("ship it", "steer", "id-1"), listOf(body.getString("text"), body.getString("mode"), body.getString("client_id")))
    }

    @Test fun aSendWithFilesIsTheSameSendOnlyWithTheSameFiles() {
        val photo = Upload("u1", "image", "image/png", "photo.png", 70)
        val notes = Upload("u2", "file", "text/plain", "notes.txt", 12)
        // Words alone keep the key they had; files make it another send.
        assertEquals("look", Wire.sendKey("look", emptyList()))
        val one = Wire.sendKey("look", listOf(photo))
        assertEquals(setOf("u1"), Wire.keyFiles(one))
        assertEquals(emptySet<String>(), Wire.keyFiles("look"))
        var n = 0
        val fresh = { "id-${++n}" }
        val first = Wire.sendId("", "", one, fresh)
        assertEquals(first, Wire.sendId(first, one, Wire.sendKey("look", listOf(photo)), fresh))
        assertEquals("id-2", Wire.sendId(first, one, Wire.sendKey("look", listOf(photo, notes)), fresh))
        // Files alone, with no words, are a send of their own.
        val body = Wire.sendBody("", "send", "c", listOf(photo, notes))
        assertEquals(listOf("u1", "u2"), (0 until 2).map { body.getJSONArray("attachments").getJSONObject(it).getString("id") })
        assertEquals(false, Wire.sendBody("hi", "send", "c").has("attachments"))
    }

    @Test fun aPhotoGoesUpAtTheEdgeTheDaemonStoresAndInATypeTheModelReads() {
        val inline = Me.DEFAULT_INLINE
        // Within the edge and readable: as picked.
        assertNull(Wire.photoPlan("image/jpeg", 1600, 1200, 2000, inline))
        // A camera photo: scaled to the edge on its long side, still JPEG.
        assertEquals(Wire.Photo(2000, 1500, "image/jpeg"), Wire.photoPlan("image/jpeg", 4032, 3024, 2000, inline))
        assertEquals(Wire.Photo(1500, 2000, "image/jpeg"), Wire.photoPlan("image/jpeg", 3024, 4032, 2000, inline))
        // A screenshot stays PNG.
        assertEquals(Wire.Photo(923, 2000, "image/png"), Wire.photoPlan("image/png", 1080, 2340, 2000, inline))
        // A HEIC photo, which no model reads, is written as JPEG at any size.
        assertEquals(Wire.Photo(800, 600, "image/jpeg"), Wire.photoPlan("image/heic", 800, 600, 2000, inline))
        // A daemon that names no edge: only the type is changed.
        assertNull(Wire.photoPlan("image/jpeg", 8000, 6000, null, inline))
        assertNull(Wire.photoPlan("application/pdf", 10, 10, 2000, inline))
        // A photo that says where it was taken is written again, at its own size.
        assertEquals(Wire.Photo(1600, 1200, "image/jpeg"), Wire.photoPlan("image/jpeg", 1600, 1200, 2000, inline, located = true))
        assertEquals(Wire.Photo(1600, 1200, "image/jpeg"), Wire.photoPlan("image/webp", 1600, 1200, 2000, inline, located = true))
        assertEquals("IMG_1.jpg", Wire.renamed("IMG_1.HEIC", "image/jpeg"))
        assertEquals("photo.jpg", Wire.renamed("", "image/jpeg"))
    }

    @Test fun aPhotoThePickerNamesByItsIdIsNamedByItsDate() {
        val zone = java.time.ZoneId.of("Asia/Jerusalem")
        // 2026-11-20 12:32:05 UTC, 14:32:05 on the phone's clock.
        val taken = java.time.Instant.parse("2026-11-20T12:32:05Z").toEpochMilli()
        assertEquals("Photo 2026-11-20 at 14.32.05.jpg", Wire.pickedName("1000000044.jpg", "image/jpeg", "1000000044", taken, zone))
        assertEquals("Photo 2026-11-20 at 14.32.05.png", Wire.pickedName("", "image/png", "1000000045", taken, zone))
        // A real name, a file that is not a photo, or a date nobody knows: the name stays.
        assertEquals("receipt.png", Wire.pickedName("receipt.png", "image/png", "1000000045", taken, zone))
        assertEquals("1000000046.pdf", Wire.pickedName("1000000046.pdf", "application/pdf", "1000000046", taken, zone))
        assertEquals("1000000044.jpg", Wire.pickedName("1000000044.jpg", "image/jpeg", "1000000044", null, zone))
        // A real name of digits only (a camera's 20261120143205.jpg, a scan's 0001.png) is not the media id: it stays.
        assertEquals("20261120143205.jpg", Wire.pickedName("20261120143205.jpg", "image/jpeg", "1000000047", taken, zone))
        assertEquals("0001.png", Wire.pickedName("0001.png", "image/png", null, taken, zone))
        // The photo picker names every photo by an id, whatever its URI ends with.
        assertEquals("Photo 2026-11-20 at 14.32.05.jpg", Wire.pickedName("1000000048.jpg", "image/jpeg", "48", taken, zone, picker = true))
    }

    @Test fun aFileTooLargeIsRefusedBeforeItGoesUp() {
        val max = 20L * 1024 * 1024
        assertEquals("", Wire.tooLarge("a.zip", max, max))
        assertEquals("a.zip is 25 MB; the computer takes at most 20 MB a file.", Wire.tooLarge("a.zip", 25L * 1024 * 1024, max))
        // A size or a limit nobody knows: the daemon judges.
        assertEquals("", Wire.tooLarge("a.zip", null, max))
        assertEquals("", Wire.tooLarge("a.zip", max * 2, null))
        // The name and type go in the query as encodeURIComponent writes them (the signed bytes are the sent ones).
        assertEquals("/v1/upload?name=IMG%201%20(2).jpg&mime=image%2Fjpeg", Wire.uploadPath("IMG 1 (2).jpg", "image/jpeg"))
        assertEquals("/v1/upload?name=file&mime=application%2Foctet-stream", Wire.uploadPath("", ""))
    }

    @Test fun aSessionWhoseTurnWaitsOnTheOwnerNeedsThemThoughItRuns() {
        val chat = Chat("s-1", "Refactor", "needs_you", 1.0, 0, false, false, "", "agent", null)
        // A plan waits inside a running turn: the daemon says needs_you, and that is what the list shows.
        assertEquals(State.NEEDS, stateOf(chat, pendingCard = false, working = true))
        assertEquals(State.WORKING, stateOf(chat.copy(status = "working"), pendingCard = false, working = true))
    }

    @Test fun aPlanCardNamesItsWaysOnAndSendsWhatToChange() {
        val plan = Card.of(JSONObject("""{"id":"plan-c7","chat_id":"s-1","kind":"plan","command":"Split","description":"","actions":[["Approve: edits run","session","primary"],["Approve: each change asks","once",""],["Keep planning","deny","danger"]],"state":"pending","choice":null,"ts":1,"text":"1. a\n2. b","lines":2,"hold":["plan"]}"""))
        assertEquals(true, plan.plan)
        // The daemon's words, never a permission's "Allow for session".
        assertEquals(listOf("Approve: edits run", "Approve: each change asks", "Keep planning"), plan.actions.map { plan.label(it.choice, it.label) })
        assertEquals(false, plan.mayAllow(read = false))
        val back = Wire.answerBody("deny", null, feedback = "Keep the thread.")
        assertEquals("Keep the thread.", back.getString("feedback"))
        assertEquals(false, Wire.answerBody("deny", null, feedback = " ").has("feedback"))
        assertEquals(false, Wire.answerBody("session", null, seen = true, feedback = "x").has("feedback"))
    }

    @Test fun aTextIsReadOnlyWhenWhatWasDrawnCoversAllOfIt() {
        // The top, then a jump to the end: the middle was never drawn.
        val jump = Seen().apply { add(0f, 450f); add(1100f, 1600f) }
        assertEquals(false, jump.covers(1600f))
        // The middle passes through as the list or the box moves: read.
        jump.add(400f, 1150f)
        assertEquals(true, jump.covers(1600f))
        // One pixel of the top edge is not the top of the text.
        assertEquals(false, Seen().apply { add(0f, 1f); add(1f, 300f) }.covers(1600f))
        // Parts that meet within a pixel join.
        assertEquals(true, Seen().apply { add(0.5f, 800f); add(800.6f, 1599.4f) }.covers(1600f))
    }

    @Test fun aDiffIsLinesWithTheirNumbersInTheOldAndNewFile() {
        val d = "diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@ fun main\n one\n-two\n+TWO\n+three\n four\n\\ No newline at end of file\n@@ -10 +11 @@\n-x\n+y"
        val l = diffLines(d)
        assertEquals(listOf('@', ' ', '-', '+', '+', ' ', '\\', '@', '-', '+'), l.map { it.kind })
        assertEquals(DiffLine(' ', "one", 1, 1), l[1])
        assertEquals(DiffLine('-', "two", 2, null), l[2])
        assertEquals(DiffLine('+', "three", null, 3), l[4])
        assertEquals(DiffLine(' ', "four", 3, 4), l[5])
        assertEquals(DiffLine('-', "x", 10, null), l[8])
        assertEquals(DiffLine('+', "y", null, 11), l[9])
        // The headers are not lines; a binary file has none.
        assertEquals(emptyList<DiffLine>(), diffLines("diff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ"))
        assertEquals(FileChange("src/a/b.kt", "M", 1, 0).let { it.name to it.dir }, "b.kt" to "src/a")
    }

    @Test fun theAgentTreeListsEachAgentFollowedByItsOwnOldestFirst() {
        fun c(id: String, parent: String?, created: Double) = Chat(id, id, "idle", created, 0, false, false, "", "", parent, created = created)
        // A root with two agents; the first started a worker, which started a checker; a loop in damaged data.
        val chats = listOf(c("root", null, 0.0), c("b", "root", 2.0), c("a", "root", 1.0), c("a1", "a", 3.0), c("a1x", "a1", 4.0),
            c("other", null, 0.0), c("o1", "other", 1.0), c("x", "y", 1.0), c("y", "x", 1.0))
        assertEquals(listOf(Triple("a", 1, 2), Triple("a1", 2, 1), Triple("a1x", 3, 0), Triple("b", 1, 0)), agentTree(chats, "root").map { Triple(it.chat.id, it.depth, it.below) })
        assertEquals(listOf("a1x"), agentTree(chats, "a1").map { it.chat.id })
        assertEquals(emptyList<String>(), agentTree(chats, "b").map { it.chat.id })
        val byId = chats.associateBy { it.id }
        assertEquals("root", rootOf(byId, "a1x"))
        assertEquals("root", rootOf(byId, "root"))
        // A loop ends: x and y each name the other.
        assertTrue(rootOf(byId, "x") in setOf("x", "y"))
    }

    @Test fun whenThePhoneWasLastLevelIsSaidInItsOwnTime() {
        val z = java.time.ZoneId.of("Asia/Jerusalem")
        val now = java.time.ZonedDateTime.of(2026, 11, 23, 18, 5, 0, 0, z).toInstant().toEpochMilli()
        fun at(d: Int, h: Int, m: Int) = java.time.ZonedDateTime.of(2026, 11, d, h, m, 0, 0, z).toInstant().toEpochMilli()
        assertEquals("14:32", syncedAt(at(23, 14, 32), now, z))
        assertEquals("Sat 09:05", syncedAt(at(21, 9, 5), now, z))
        assertEquals("2 Nov 23:59", syncedAt(at(2, 23, 59), now, z))
        // Out of reach is said once, in words; anything else as it came.
        assertEquals(OUT_OF_REACH, reach(java.net.ConnectException("Failed to connect to /10.0.2.2:49085")))
        assertEquals(OUT_OF_REACH, reach(java.net.UnknownHostException("desk.example")))
        assertEquals(OUT_OF_REACH, reach(java.net.SocketTimeoutException("timeout")))
        assertEquals("bad signature", reach(ApiError(401, "bad signature")))
    }

    @Test fun aSessionThatNeedsTheOwnerSaysWhatItAsks() {
        fun chat(id: String, parent: String? = null) = Chat(id, id.replaceFirstChar { it.uppercase() }, "needs_you", 1.0, 0, false, false, "Step 1 of 1.", "agent", parent)
        val chats = listOf(chat("root"), chat("worker", "root"), chat("other")).associateBy { it.id }
        fun card(id: String, chat: String, kind: String, ts: Double, command: String = "", line: String = "", qs: List<String> = emptyList()) =
            Card(id, chat, kind, command, "", emptyList(), "pending", null, ts, qs.mapIndexed { i, q -> Question("q$i", q, listOf("a"), false) }, line = line)
        val allow = card("apr-1", "root", "permission", 2.0, command = "rm -rf build", line = "Bash: rm -rf build")
        val ask = card("q-1", "worker", "question", 1.0, qs = listOf("Which database should the cache use?", "Which region?"))
        val plan = card("plan-other.c1", "other", "plan", 3.0, command = "Split the store")
        val all = listOf(allow, ask, plan)
        // The oldest first, an agent's named; what else waits counted.
        assertEquals("Worker: Asks: Which database should the cache use? (and 1 more question) · 1 more waiting", askLine("root", all, chats))
        assertEquals("Allow? Bash: rm -rf build", askLine("root", listOf(allow), chats))
        assertEquals("Plan to approve: Split the store", askLine("other", all, chats))
        // A line runs on one line; a closed card asks nothing.
        assertEquals("Allow? Bash: cd /srv && make", askLine("root", listOf(allow.copy(line = "Bash: cd /srv\n  && make")), chats))
        assertEquals("", askLine("root", listOf(allow.copy(state = "approved")), chats))
    }

    @Test fun theLastingNotificationSaysWhatRunsAndWhatWaits() {
        // From a live push.
        val m = PushMsg.of(mapOf("t" to "live", "w" to "2", "q" to "1", "title" to "2 sessions working · 1 needs you", "body" to "Fix the build · Docs", "since" to "1795195000500"))
        assertEquals(Live(2, 1, "2 sessions working · 1 needs you", "Fix the build · Docs", 1795195000500), Live.of(m))
        assertEquals(false, Live.of(PushMsg.of(mapOf("t" to "live", "w" to "0", "q" to "0"))).shown)
        // From what the app holds as it goes to the back: an agent's turn is its root's, the oldest first.
        fun chat(id: String, title: String, parent: String? = null) = Chat(id, title, "working", 1.0, 0, false, false, "", "", parent)
        val chats = listOf(chat("a", "Fix the build"), chat("b", "Docs"), chat("a1", "Worker", "a")).associateBy { it.id }
        val held = Live.of(mapOf("b" to 200.0, "a" to 100.0, "a1" to 150.0), listOf(Card("q-1", "a1", "question", "", "", emptyList(), "pending", null, 1.0, emptyList())), chats)
        // Fix the build's agent asks: it needs the owner, Docs works.
        assertEquals(Live(1, 1, "1 session working · 1 needs you", "Docs", 200_000), held)
        assertEquals(false, Live.of(emptyMap(), emptyList(), chats).shown)
    }

    @Test fun theAppCountsWhatRunsAsTheDaemonDoes() {
        // A root whose agents work counts as working (its own turn ended); an archived root counts for nothing.
        val chats = listOf(
            Chat("lead", "Leads agents", "idle", 1.0, 0, false, false, "", "", null, agents = 1),
            Chat("w1", "Worker", "working", 1.0, 0, false, false, "", "", "lead"),
            Chat("shelf", "Shelved", "working", 1.0, 0, false, true, "", "", null),
            Chat("runs", "Runs", "working", 1.0, 0, false, false, "", "", null),
        ).associateBy { it.id }
        val card = Card("apr-1", "shelf", "approval", "", "", emptyList(), "pending", null, 1.0, emptyList())
        val l = Live.of(mapOf("w1" to 150.0, "shelf" to 50.0, "runs" to 100.0), listOf(card), chats)
        assertEquals(Live(2, 0, "2 sessions working", "Runs · Leads agents", 100_000), l)
    }

    @Test fun aSnippetMarksTheWordsFound() {
        assertEquals(listOf("The " to false, "invoice" to true, " " to false, "total" to true, " is off." to false), snippetParts("The \u0001invoice\u0002 \u0001total\u0002 is off."))
        assertEquals(listOf("no marks" to false), snippetParts("no marks"))
        // A mark left open runs to the end.
        assertEquals(listOf("…" to false, "drift" to true), snippetParts("…\u0001drift"))
    }

    @Test fun aFailedReadOfEarlierMessagesOffersTheRightWayOn() {
        // The cursor is no longer on the shown branch: the same page cannot be read again.
        assertEquals(Earlier.RELOAD, earlierAfter(409))
        // The daemon was busy, or out of reach (no HTTP code at all).
        assertEquals(Earlier.AGAIN, earlierAfter(503))
        assertEquals(Earlier.AGAIN, earlierAfter(null))
    }

    @Test fun unpairingSaysWhetherTheDaemonRevokedThePhone() {
        // Online: the daemon confirms. A daemon that had revoked the phone already no longer knows its token.
        assertEquals(Unpaired(true, "Unpaired. desk no longer accepts this phone."), unpaired(JSONObject().put("ok", true), null, null, "desk"))
        assertEquals(true, unpaired(null, 401, "unauthorized", "desk").revoked)
        // Offline (no answer, no HTTP code), an error from the daemon, an answer that does not confirm, and a 401
        // for another reason (the phone's clock is off, so its signature is refused): local only.
        val local = listOf(
            unpaired(null, null, null, "desk"), unpaired(null, 503, "HTTP 503", "desk"), unpaired(JSONObject().put("ok", false), null, null, "desk"),
            unpaired(null, 401, "bad signature", "desk"), unpaired(null, 401, "Not authorized (HTTP 401)", "desk"),
        )
        for (u in local) {
            assertEquals(false, u.revoked)
            assertEquals(true, u.note.contains("did not confirm") && u.note.contains("Settings, then Phone"))
        }
    }

    @Test fun pairLinks() {
        val l = Wire.parsePair("keel://pair?u=https%3A%2F%2Fkeel.example.test&c=abc123&n=desk%20one")!!
        assertEquals(Wire.PairLink("https://keel.example.test", "abc123", "desk one"), l)
        assertEquals("http://10.0.2.2:47988", Wire.parsePair("keel://pair?u=http%3A%2F%2F10.0.2.2%3A47988%2F&c=x")!!.base)
        assertEquals(Wire.PairLink("https://keel.example.test:8443", "zz", "keel.example.test"), Wire.parsePair("https://keel.example.test:8443/pair?c=zz"))
        assertNull(Wire.parsePair("hermes://pair?u=https%3A%2F%2Fa.test&c=x"))
        assertNull(Wire.parsePair("keel://pair?u=https%3A%2F%2Fa.test"))
        assertNull(Wire.parsePair("keel://pair?u=javascript%3Aalert(1)&c=x"))
        assertNull(Wire.parsePair("https://a.test/other?c=x"))
    }

    private fun chat(status: String) = Chat.of(JSONObject().put("id", "c").put("title", "t").put("status", status))

    @Test fun stateComesFromCardsThenWorkThenTheLastTurn() {
        assertEquals(State.NEEDS, stateOf(chat("done"), pendingCard = true, working = true))
        assertEquals(State.WORKING, stateOf(chat("done"), pendingCard = false, working = true))
        assertEquals(State.FAILED, stateOf(chat("failed"), false, false))
        assertEquals(State.STOPPED, stateOf(chat("stopped"), false, false))
        assertEquals(State.DONE, stateOf(chat("done"), false, false))
        assertEquals(State.IDLE, stateOf(Chat.of(JSONObject().put("id", "c")), false, false))
    }

    @Test fun markdownBlocks() {
        val b = blocks("# Title\n\nA **bold** line\nwrapped.\n\n- one\n- two\n\n```kotlin\nval x = 1\n```\n| a | b |\n|---|---|\n| 1 | 2 |")
        assertEquals(Block.Heading(1, "Title"), b[0])
        assertEquals(Block.Para("A **bold** line wrapped."), b[1])
        assertEquals(Block.Item("•", "two", 0), b[3])
        assertEquals(Block.Code("kotlin", "val x = 1"), b[4])
        // A fence inside a list item: the code is copied without the item's indent, its own kept.
        val nested = blocks("1. Run this:\n\n   ```sh\n   git push origin main\n     --force-with-lease\n   ```")
        assertEquals(Block.Code("sh", "git push origin main\n  --force-with-lease"), nested.last())
        assertEquals(Block.Table(listOf(listOf("a", "b"), listOf("1", "2"))), b[5])
    }

    @Test fun mathIsSetAsTheWorkbenchFindsIt() {
        // Display math on its own lines, once it is closed; a reply still streaming shows it as written.
        val b = blocks("The recurrence:\n\n$$ T(n) = 2T\\left(\\frac{n}{2}\\right) + O(n) $$\n\nand\n\\[\na^2 + b^2\n\\]\n\n$$ x = 1")
        assertEquals(Block.Math("T(n) = 2T\\left(\\frac{n}{2}\\right) + O(n)"), b[1])
        assertEquals(Block.Math("a^2 + b^2"), b[3])
        assertEquals(Block.Para("$$ x = 1"), b[4])
        // Inline by Pandoc's rule: $O(n)$ and \(x\) are math; prices and shell variables are not.
        assertEquals(Triple(6, "O(n)", false), inlineMath("\$O(n)\$ time", 0))
        assertEquals(Triple(5, "x", false), inlineMath("\\(x\\)", 0))
        assertNull(inlineMath("\$5 and \$10", 0))
        assertNull(inlineMath("\$HOME and \$PATH ", 0))
        // Set as text: math italic letters, spaced operators, a fraction as a/b, symbols as characters.
        assertEquals("T(n) = 2T(n/2) + O(n)", mathText("T(n) = 2T\\left(\\frac{n}{2}\\right) + O(n)"))
        assertEquals("(a + b)/2", mathText("\\frac{a+b}{2}"))
        assertEquals("O(n\u2009log\u2009n)", mathText("O(n \\log n)"))
        assertEquals("α ≤ √(x + 1) → ∞", mathText("\\alpha \\le \\sqrt{x+1} \\to \\infty"))
        assertEquals("−1, ℝ", mathText("-1, \\mathbb{R}"))
        val runs = mathRuns("x^2 + y_i")
        assertEquals(listOf(MathRun("x", italic = true), MathRun("2", level = 1), MathRun(" + "), MathRun("y", italic = true), MathRun("i", italic = true, level = -1)), runs)
        // An environment's rows are lines; a cases brace opens the first.
        assertEquals("{1\u2003n = 0\n\u2007n!\u2003otherwise", mathText("\\begin{cases} 1 & n = 0 \\\\ n! & \\text{otherwise} \\end{cases}"))
        // What it does not know is shown as written.
        assertEquals("\\foo\u2009x", mathText("\\foo x"))
    }

    // A reply is set on the UI thread, again on every streamed token: no reply, however it is made,
    // overflows the stack or takes long. Each case runs on a thread with a small stack and a deadline.
    @Test fun mathIsSetInBoundedTimeAndStack() {
        val bad = mutableListOf<String>()
        fun bounded(name: String, body: () -> Unit) {
            var err: Throwable? = null
            val t = Thread(null, { try { body() } catch (e: Throwable) { err = e } }, name, 512L shl 10)
            t.start(); t.join(5000)
            if (t.isAlive) bad += "$name took over 5 s" else if (err != null) bad += "$name threw ${err!!.javaClass.simpleName}"
        }
        val sp = SpanStyle()
        val deep = "{".repeat(20_000) + "x" + "}".repeat(20_000)
        bounded("20,000 nested braces") { assertTrue(mathText(deep).isNotEmpty()) }
        bounded("20,000 nested scripts") { mathText("x^".repeat(20_000) + "2") }
        bounded("a 30 KB line of prices") { inline("costs \$5 " + "word ".repeat(6000) + "\$6 x", sp, sp) }
        bounded("a megabyte of lone \$") { inline("\$ ".repeat(500_000), sp, sp) }
        bounded("a megabyte of \$x\$") { inline("\$x\$ ".repeat(250_000), sp, sp) }
        bounded("a megabyte of \\(") { inline("\\(".repeat(500_000), sp, sp) }
        bounded("a megabyte of [") { inline("[".repeat(1_000_000), sp, sp) }
        bounded("100,000 unclosed display openers") { blocks("\\[ a\n".repeat(50_000) + "\$\$ b\n".repeat(50_000)) }
        assertEquals(emptyList<String>(), bad)
        // Links and math are still found as they were, now without a regular expression per opener.
        assertEquals("see docs, [a](b c) and x", inline("see [docs](https://x.y), [a](b c) and \$x\$", sp, sp).text)
        assertEquals(1, inline("see [docs](https://x.y)", sp, sp).spanStyles.size)
        assertEquals(Triple(7, "a+b", true), inlineMath("\$\$a+b\$\$", 0))
        assertEquals(Triple(8, "a \\$ b", false), inlineMath("\$a \\$ b\$", 0))
        assertNull(inlineMath("\\(x\ny\\)", 0))
        // Math longer than a formula is text, and display math ends at a blank line.
        assertNull(inlineMath("\$" + "x".repeat(2_100) + "\$", 0))
        assertEquals(Block.Para("\$\$ a"), blocks("\$\$ a\n\nb \$\$")[0])
        // Deeper than math is written is shown as written.
        assertEquals("{".repeat(100) + "x" + "}".repeat(100), mathText("{".repeat(100) + "x" + "}".repeat(100)))
    }

    @Test fun times() {
        assertEquals("now", ago(100.0, 120.0))
        assertEquals("5m", ago(0.0, 300.0))
        assertEquals("4m 05s", elapsed(0.0, 245.0))
    }

    // A permission is allowed only for what was read. The daemon says why a request is held;
    // the app says, with an allow, that all of its text was on screen.
    @Test fun aHeldRequestIsAllowedOnlyOnceItWasRead() {
        val held = Card.of(JSONObject("""{"id":"a1","kind":"permission","command":"cd /srv","text":"cd /srv\nrm -rf build","lines":2,"hold":["long"],"notes":["Runs on build box."],"state":"pending"}"""))
        assertEquals(listOf(true, false, true), listOf(held.held, held.mayAllow(false), held.mayAllow(true)))
        assertEquals("cd /srv\nrm -rf build", held.shown)
        assertEquals("Scroll to the end of all 2 lines to allow it.", held.readFirst)
        assertEquals("Read the whole request to allow it.", held.copy(lines = 1, hold = listOf("risk")).readFirst)
        // One line shows all of it: nothing stands in the way.
        val short = Card.of(JSONObject("""{"id":"a2","kind":"permission","command":"npm test","text":"npm test","lines":1,"hold":[],"state":"pending"}"""))
        assertEquals(listOf(false, true, ""), listOf(short.held, short.mayAllow(false), short.readFirst))
        // A daemon from before the rule sends no text and no hold: the card shows its command, as it did.
        val old = Card.of(JSONObject("""{"id":"a3","kind":"permission","command":"npm test","state":"pending"}"""))
        assertEquals(listOf("npm test", false, true), listOf(old.shown, old.held, old.mayAllow(false)))

        // An allow says the text was read; a refusal and a notification's answer never do.
        assertEquals("""{"choice":"once","seen":"whole"}""", Wire.answerBody("once", null, seen = true).toString())
        assertEquals("""{"choice":"once"}""", Wire.answerBody("once", null).toString())
        assertEquals("""{"choice":"deny"}""", Wire.answerBody("deny", null, seen = true).toString())
        assertEquals("""{"choice":"once","via":"notification"}""", Wire.answerBody("once", null, seen = true, via = "notification").toString())
        assertEquals("""{"choice":"deny","via":"notification"}""", Wire.answerBody("deny", null, via = "notification").toString())

        // A push for a held request carries no Allow: the notification offers Open and Deny.
        assertEquals(listOf(true, false, listOf("deny")), PushMsg.of(mapOf("t" to "approval", "aid" to "a1", "opts" to "[\"deny\"]", "hold" to "long,marked")).let { listOf(it.held, it.allows, it.choices) })
        assertEquals(true, PushMsg.of(mapOf("t" to "approval", "aid" to "a2", "opts" to "[\"once\",\"deny\"]", "hold" to "")).allows)
        // Not held, but longer than a collapsed notification shows: the daemon offers no Allow, and the app adds none.
        assertEquals(false, PushMsg.of(mapOf("t" to "approval", "aid" to "a5", "opts" to "[\"deny\"]", "hold" to "")).allows)
        // A daemon from before opts: as it was.
        assertEquals(true, PushMsg.of(mapOf("t" to "approval", "aid" to "a2")).allows)
    }

    // A notification carries Allow once only for a request whose whole line it shows, and a standing
    // answer's button names the rule it stores.
    @Test fun aNotificationAllowsOnlyWhatItsLineShowsAndAStandingAnswerNamesItsRule() {
        val card = { json: String -> Card.of(JSONObject(json)) }
        val short = card("""{"id":"a1","kind":"permission","command":"npm test","text":"npm test","hold":[],"line":"Bash: npm test","glance":true,"grants":["npm test"],"state":"pending"}""")
        assertEquals(listOf(true, "Bash: npm test"), listOf(short.glanceable, short.noteLine))
        // Not held, but its line is longer than a collapsed notification shows.
        val wide = card("""{"id":"a2","kind":"permission","command":"echo ok ; echo tail","hold":[],"line":"Bash: echo ok                         ; echo tail","glance":false,"state":"pending"}""")
        assertEquals(false, wide.glanceable)
        assertEquals(false, card("""{"id":"a3","kind":"permission","command":"x","hold":["where"],"line":"Bash on build-box: x","glance":false,"state":"pending"}""").glanceable)
        // A daemon from before the line: a request it does not hold is allowed as it was.
        val old = card("""{"id":"a4","kind":"permission","command":"npm test","state":"pending"}""")
        assertEquals(listOf(true, "npm test"), listOf(old.glanceable, old.noteLine))

        assertEquals("Allow npm test for this session", short.label("session", "This session"))
        assertEquals("Always allow npm test", short.label("always", ""))
        assertEquals(listOf("Allow once", "Deny"), listOf(short.label("once", ""), short.label("deny", "")))
        assertEquals("Allow echo *, git status for this session", short.copy(grants = listOf("echo *", "git status")).label("session", ""))
        assertEquals("Allow for session", old.label("session", "This session"))
    }

    @Test fun lettersWrittenRightToLeftStayWhereTheyAreWritten() {
        // Each run is set apart, so it reads as written and the words around it keep their order.
        assertEquals("cp \u2067\u05d0\u2069 1 2 \u2067\u05d1\u05d2\u2069 > x", Wire.inPlace("cp \u05d0 1 2 \u05d1\u05d2 > x"))
        assertEquals("npm test", Wire.inPlace("npm test"))
        assertEquals("\u2067\u0645\u0631\u2069", Wire.inPlace("\u0645\u0631"))
        val card = Card.of(JSONObject().put("id", "a4").put("text", "cp \u05d0 b").put("rtl", true).put("hold", org.json.JSONArray().put("marked")))
        assertEquals("cp \u2067\u05d0\u2069 b", card.shown)
    }
}
