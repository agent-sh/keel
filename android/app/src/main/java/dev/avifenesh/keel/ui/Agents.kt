// A session's agents on the phone: the tree under it (the agents it started, theirs, and so on), one
// quiet item over the box until opened; and in an agent's session, the way up to the session that started it.
package dev.avifenesh.keel.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.avifenesh.keel.AgentRow
import dev.avifenesh.keel.Chat
import dev.avifenesh.keel.State
import dev.avifenesh.keel.dotOf
import dev.avifenesh.keel.dotWordOf
import dev.avifenesh.keel.look
import dev.avifenesh.keel.agentTree
import dev.avifenesh.keel.agentsMark
import dev.avifenesh.keel.agentsWord
import dev.avifenesh.keel.stateOf

/** In an agent's session, the way up to the session that started it. Nothing for a session no agent started. */
@Composable
fun StarterLine(id: String, chats: Map<String, Chat>, onOpen: (String) -> Unit) {
    val k = k()
    val parent = chats[id]?.parentId?.let { chats[it] } ?: return
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().press({ onOpen(parent.id) }).semantics { contentDescription = "starter-${parent.title}" }.padding(horizontal = S.lg, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KIcon(Ic.CornerLeftUp, k.faint, 16.dp)
            Spacer(Modifier.width(8.dp))
            Txt("Started by ", T.small, k.muted)
            Txt(parent.title, T.small, k.muted, Modifier.weight(1f), maxLines = 1)
        }
        Rule()
    }
}

/**
 * The agents under session `id`, as one quiet item over the box: "Agents N", with one mark only when an
 * agent waits on the owner (and the words) or failed. Opened, the tree, one row an agent. `needs`: the
 * sessions with a card that waits; `working`: the running turns by session. Nothing for a session that
 * started no agent.
 */
@Composable
fun AgentsBar(id: String, chats: Map<String, Chat>, needs: Set<String>, working: Map<String, Double>, @Suppress("UNUSED_PARAMETER") now: Double, onOpen: (String) -> Unit) {
    val k = k()
    val rows = agentTree(chats.values, id)
    if (rows.isEmpty()) return
    // An agent needs the owner when a card of its own waits. One the daemon calls "needs you" for a card of
    // an agent below it waits on that agent: it works, and the row of the one that asks says so.
    val states = rows.associate { r ->
        val own = r.chat.id in needs
        r.chat.id to if (!own && r.chat.status == "needs_you") State.WORKING else stateOf(r.chat, own, r.chat.id in working)
    }
    val need = states.values.count { it == State.NEEDS }
    val failed = states.values.count { it == State.FAILED }
    val mark = agentsMark(need, failed)
    // Open by itself when an agent waits on the owner: that is what they came to answer.
    var open by rememberSaveable(id) { mutableStateOf(need > 0) }
    Column(Modifier.fillMaxWidth().animateContentSize()) {
        Rule()
        // A tall tree scrolls in its own place, over the item: the conversation keeps the screen.
        if (open) Column(Modifier.fillMaxWidth().heightIn(max = 280.dp).verticalScroll(rememberScrollState()).padding(top = 4.dp)) {
            for (r in rows) AgentLine(r, states.getValue(r.chat.id)) { onOpen(r.chat.id) }
        }
        Row(
            Modifier.fillMaxWidth().press({ open = !open }).semantics { contentDescription = "agents-${rows.size}" }.padding(horizontal = S.lg, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Txt(agentsWord(rows.size), T.small, k.muted)
            if (mark == State.NEEDS) { Spacer(Modifier.width(S.sm)); StateTag(State.NEEDS, "$need need${if (need == 1) "s" else ""} you", only = true) }
            else if (mark != null) { Spacer(Modifier.width(S.sm)); Box(Modifier.semantics { contentDescription = "agents-mark-failed" }) { StateMark(mark, 8.dp) } }
            Spacer(Modifier.weight(1f))
            KIcon(if (open) Ic.ChevronDown else Ic.ChevronRight, k.faint, 16.dp)
        }
    }
}

/** One agent of the tree: its mark, its title, and what it is at in a quiet line. No clock or count on a row: its session has them. */
@Composable
private fun AgentLine(r: AgentRow, s: State, onOpen: () -> Unit) {
    val k = k()
    val c = r.chat
    // Each level in by a step, four at most: a deep chain stays readable on a phone.
    val indent = (minOf(r.depth, 4) - 1) * 16
    Row(
        Modifier.fillMaxWidth().press(onOpen).semantics { contentDescription = "agent-row-${c.title}" }
            .padding(start = S.lg + indent.dp, end = S.lg, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        val (dot, ring) = dotOf(c, s)
        Box(Modifier.padding(top = 5.dp, end = 10.dp)) { DotMark(look(dot, ring, dotWordOf(c, dot, ring), reducedMotion()), 9.dp) }
        Column(Modifier.weight(1f)) {
            Txt(c.title, T.ui, k.fg, maxLines = 1)
            val line = when {
                s == State.FAILED -> c.failure.ifBlank { "Failed" }
                s == State.WORKING && c.status == "needs_you" -> "Waits on an agent below it"
                c.stateWord.isNotBlank() -> c.stateWord
                else -> s.word
            }
            Txt(line, T.meta, if (s == State.FAILED) k.failInk else k.muted, maxLines = 1)
        }
    }
}
