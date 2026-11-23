// A session's agents on the phone: the tree under it (the agents it started, theirs, and so on), each
// with its state, folded into one line until opened; and in an agent's session, the way up to the
// session that started it.
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
import dev.avifenesh.keel.agentTree
import dev.avifenesh.keel.ago
import dev.avifenesh.keel.elapsed
import dev.avifenesh.keel.stateOf

/**
 * The agents under session `id`, and its starter when it is an agent. `needs`: the sessions with a card
 * that waits; `working`: the running turns by session, with when they started. Shows nothing for a
 * session that started no agent and was started by none.
 */
@Composable
fun AgentsBar(id: String, chats: Map<String, Chat>, needs: Set<String>, working: Map<String, Double>, now: Double, onOpen: (String) -> Unit) {
    val k = k()
    val parent = chats[id]?.parentId?.let { chats[it] }
    val rows = agentTree(chats.values, id)
    if (parent == null && rows.isEmpty()) return
    val states = rows.associate { it.chat.id to stateOf(it.chat, it.chat.id in needs, it.chat.id in working) }
    val need = states.values.count { it == State.NEEDS }
    val work = states.values.count { it == State.WORKING }
    val failed = states.values.count { it == State.FAILED }
    // Open by itself when an agent waits on the owner: that is what they came to answer.
    var open by rememberSaveable(id) { mutableStateOf(need > 0) }
    Column(Modifier.fillMaxWidth().background(k.panel).animateContentSize()) {
        if (parent != null) Row(
            Modifier.fillMaxWidth().press({ onOpen(parent.id) }).semantics { contentDescription = "starter-${parent.title}" }.padding(horizontal = S.lg, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KIcon(Ic.CornerLeftUp, k.muted, 16.dp)
            Spacer(Modifier.width(8.dp))
            Txt("Started by ", T.small, k.muted)
            Txt(parent.title, T.small.copy(fontWeight = T.uiStrong.fontWeight), k.fg, Modifier.weight(1f), maxLines = 1)
        }
        if (rows.isNotEmpty()) {
            if (parent != null) Rule()
            Row(
                Modifier.fillMaxWidth().press({ open = !open }).semantics { contentDescription = "agents-${rows.size}" }.padding(horizontal = S.lg, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                KIcon(if (open) Ic.ChevronDown else Ic.ChevronRight, k.faint, 16.dp)
                Spacer(Modifier.width(8.dp))
                Txt("AGENTS", T.label, k.muted)
                Spacer(Modifier.width(8.dp))
                Txt("${rows.size}", T.label, k.faint)
                Spacer(Modifier.weight(1f))
                // What the tree is doing, the owner's part first.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (need > 0) { StateTag(State.NEEDS, "$need need${if (need == 1) "s" else ""} you", only = true); Spacer(Modifier.width(S.md)) }
                    if (work > 0) { StateTag(State.WORKING, "$work working", only = true); Spacer(Modifier.width(S.md)) }
                    if (failed > 0) StateTag(State.FAILED, "$failed failed", only = true)
                    if (need == 0 && work == 0 && failed == 0) StateTag(State.DONE, "all done", only = true)
                }
            }
            // A tall tree scrolls in its own place: the conversation keeps the screen.
            if (open) Column(Modifier.fillMaxWidth().heightIn(max = 280.dp).verticalScroll(rememberScrollState()).padding(bottom = 6.dp)) {
                for (r in rows) AgentLine(r, states.getValue(r.chat.id), working[r.chat.id], now) { onOpen(r.chat.id) }
            }
        }
        Rule()
    }
}

@Composable
private fun AgentLine(r: AgentRow, s: State, since: Double?, now: Double, onOpen: () -> Unit) {
    val k = k()
    val c = r.chat
    // Each level in by a step, four at most: a deep chain stays readable on a phone.
    val indent = (minOf(r.depth, 4) - 1) * 16
    Row(
        Modifier.fillMaxWidth().press(onOpen).semantics { contentDescription = "agent-row-${c.title}" }
            .padding(start = S.lg + indent.dp, end = S.lg, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.padding(top = 5.dp, end = 10.dp)) { StateMark(s, 9.dp) }
        Column(Modifier.weight(1f)) {
            Txt(c.title, T.ui, k.fg, maxLines = 1)
            val line = when {
                s == State.FAILED -> c.failure.ifBlank { "Failed" }
                c.stateWord.isNotBlank() -> c.stateWord
                else -> s.word
            }
            Txt(line, T.meta, if (s == State.FAILED) k.fail else k.muted, maxLines = 1)
        }
        Spacer(Modifier.width(S.sm))
        Column(horizontalAlignment = Alignment.End) {
            Txt(if (s == State.WORKING && since != null) elapsed(since, now) else ago(c.updated, now), T.meta, if (s == State.WORKING) k.work else k.faint)
            if (r.below > 0) Txt("${r.below} below", T.meta, k.faint)
        }
    }
}
