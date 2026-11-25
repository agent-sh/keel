package dev.avifenesh.keel

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.test.platform.app.InstrumentationRegistry
import dev.avifenesh.keel.ui.FrontCommand
import dev.avifenesh.keel.ui.KeelTheme
import dev.avifenesh.keel.ui.SessionList
import dev.avifenesh.keel.ui.k
import dev.avifenesh.keel.ui.sessionRows
import org.junit.Rule
import org.junit.Test
import java.io.File

// Screenshots of the screens this round changed, in both themes, written to the app's files for the QA run to pull
// (adb pull /sdcard/Android/data/<package>/files/shots). Not part of the suite's checks: each only draws.
class ShotsTest {
    @get:Rule val rule = createComposeRule()
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private fun out(name: String) = File(ctx.getExternalFilesDir(null), "shots").apply { mkdirs() }.resolve("$name.png")

    private fun chat(id: String, title: String, status: String, dot: String, line: String, unread: Int = 0, action: String = "", ring: String = "", agents: Int = 0, helper: Boolean = false, word: String = "") =
        Chat(id, title, status, 1_000.0 - id.length, unread, false, false, line, "agent", null, agents = agents, dot = dot, dotRing = ring, dotWord = word, action = action, helper = helper)

    private val chats = listOf(
        chat("h", "Pip", "idle", "idle", "Fix the build failed: the provider refused.", helper = true, word = "Not started"),
        chat("n", "Approve the migration", "needs_you", "need", "Allow Bash: bun run migrate?", unread = 1, word = "Needs you"),
        chat("w", "Fix the build", "working", "work", "Looking.", action = "Run the unit tests", word = "Working"),
        chat("e", "Review the PR", "working", "work", "Looking.", action = "Editing src/store.ts", word = "Working"),
        chat("g", "Waiting on its agents", "working", "work", "Split the work.", ring = "agents", agents = 2, word = "Waiting on agents"),
        chat("u", "Docs: write the guide", "done", "done", "Done: the guide is in docs/.", unread = 2, word = "Done"),
        chat("d", "Rename the module", "done", "done", "Renamed 14 files.", word = "Done"),
        chat("x", "Old experiment", "idle", "idle", "No messages yet", word = "Not started"),
    ).associateBy { it.id }

    private fun draw(mode: Int, name: String, face: Boolean) {
        val bmp = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888).also { b ->
            Canvas(b).apply { drawColor(0xFF7B5EA7.toInt()); val p = Paint(Paint.ANTI_ALIAS_FLAG); p.color = Color.WHITE; drawCircle(48f, 40f, 16f, p); drawCircle(48f, 100f, 40f, p) }
        }
        Face.picture.value = if (face) Face.round(bmp) else null
        try {
            rule.setContent {
                KeelTheme(mode) {
                    Box(Modifier.fillMaxSize().background(k().bg)) {
                        Column(Modifier.fillMaxSize()) {
                            Box(Modifier.background(k().bg).padding(horizontal = 20.dp, vertical = 12.dp)) { FrontCommand("w", "m1", read = { Front("job_1", "toolu_9", "Run the unit tests", 1.0) }, move = { true }, every = 60_000) }
                            Box(Modifier.weight(1f).padding(bottom = 140.dp)) { SessionList(sessionRows(chats, emptyMap(), emptyMap()), now = 1_100.0, askRow = false) }
                        }
                    }
                }
            }
            rule.waitForIdle()
            rule.mainClock.advanceTimeBy(500)
            val img = rule.onRoot().captureToImage().asAndroidBitmap()
            out(name).outputStream().use { img.compress(Bitmap.CompressFormat.PNG, 100, it) }
        } finally { Face.picture.value = null }
    }

    @Test fun listLight() = draw(1, "list-light", true)
    @Test fun listDark() = draw(2, "list-dark", true)
}
