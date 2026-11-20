// Reading-heavy bench tasks: far more text than a working model wants in its
// context (each over 300,000 characters), with a question no search answers.
// The answer is a set of customers whose words differ every time and share no
// keyword with each other, among customers whose words touch the same subject
// without meaning it.
//
// Generated text from templates does not serve: a model counts sentence
// shapes or word frequencies and finds the one line that is not filler. So
// the everyday text is written once by a cheap model (the bench's writer),
// cached in the bench directory so every arm and repetition reads the same
// bytes, scrubbed of every sentence that touches the subject, and the planted
// sentences are placed by code at seeded positions.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./tasks.ts";

export type Writer = { id: string; write(prompt: string): Promise<string> };

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMPANIES = [
  "Alder Logistics", "Birchwood Dental", "Cobalt Roofing", "Dunmore Bakeries", "Elmstead Clinics", "Fenwick Marine",
  "Granger Farms", "Holloway Print", "Ironbridge Mining", "Juniper Hotels", "Kestrel Couriers", "Larchmont Schools",
  "Millbrook Dairy", "Northgate Security", "Oakhurst Vets", "Pembury Plumbing", "Quarry Lane Builders", "Redfern Pharmacy",
  "Saltmarsh Fisheries", "Thornbury Legal", "Upland Forestry", "Vale Street Garages", "Westcott Cleaning", "Yarrow Catering",
  "Ashby Elevators", "Bramley Solar", "Crestfield Rail", "Dovecote Nurseries", "Eastleigh Pools", "Foxley Waste",
  "Glenmoor Water", "Hartwell Events", "Ivybridge Kitchens", "Kingsmead Hauliers", "Lowther Surveyors", "Moorland Telecom",
];
const PEOPLE = ["Dana", "Omar", "Priya", "Lukas", "Mei", "Tomas", "Ines", "Kofi", "Sara", "Jonas", "Aiko", "Rafael", "Nadia", "Pavel", "Leah", "Hugo"];
const ROLES = ["operations manager", "owner", "office manager", "head of field service", "finance lead", "commercial manager"];
const slug = (c: string) => c.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-$/, "");

type Plant = { company: string; text: string };
type Corpus = {
  id: string; dir: string; seed: number; count: number; plants: Plant[];
  // What the writer is asked for one company, and what no sentence of it may touch.
  ask(company: string, person: string, role: string): string;
  scrub: RegExp;
  // Lines a planted sentence may join: the interviewee's answers, or any paragraph.
  joins(line: string, person: string): boolean;
  // How a planted sentence reads where it joins (the notes name the contact).
  frame?: (text: string, person: string) => string;
};

// The writer's text for one company, cached by the writer and the prompt.
async function written(c: Corpus, w: Writer, cache: string, company: string, person: string, role: string): Promise<string> {
  const prompt = c.ask(company, person, role);
  const key = Bun.hash(`${w.id}\n${prompt}`).toString(36);
  const file = join(cache, `${c.id}-${slug(company)}-${key}.txt`);
  if (existsSync(file)) return readFileSync(file, "utf8");
  let text = "";
  for (let attempt = 0; attempt < 3 && text.length < 6_000; attempt++) text = (await w.write(prompt)).trim();
  if (text.length < 6_000) throw new Error(`the writer gave ${text.length} characters for ${company}`);
  writeFileSync(file, text);
  return text;
}

async function build(c: Corpus, w: Writer, cache: string): Promise<Record<string, string>> {
  mkdirSync(cache, { recursive: true });
  const names = COMPANIES.slice(0, c.count);
  const texts: string[] = new Array(names.length);
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < names.length) {
      const i = next++;
      texts[i] = await written(c, w, cache, names[i]!, PEOPLE[i % PEOPLE.length]!, ROLES[i % ROLES.length]!);
    }
  }));
  const r = seeded(c.seed);
  const files: Record<string, string> = {};
  names.forEach((company, i) => {
    const person = PEOPLE[i % PEOPLE.length]!;
    // Every sentence that touches the subject goes, so only the planted ones speak to it.
    const lines = texts[i]!.split("\n").map((l) => l.split(/(?<=[.!?])\s+/).filter((s) => !c.scrub.test(s)).join(" "));
    const mine = c.plants.filter((p) => p.company === company);
    const open = lines.map((l, k) => (c.joins(l, person) && k > lines.length / 3 ? k : -1)).filter((k) => k >= 0);
    for (const p of mine) {
      const k = open.splice(Math.floor(r() * open.length), 1)[0] ?? lines.length - 1;
      const s = lines[k]!.split(/(?<=[.!?])\s+/);
      s.splice(1 + Math.floor(r() * Math.max(1, s.length - 1)), 0, c.frame ? c.frame(p.text, person) : p.text);
      lines[k] = s.join(" ");
    }
    files[`${c.dir}/${slug(company)}.md`] = lines.join("\n");
  });
  return files;
}

function checkSet(reply: string, want: string[], label: string) {
  const line = reply.split("\n").find((l) => /customers\s*=/i.test(l));
  if (!line) return { ok: false, why: "no customers=<...> line" };
  const said = line.split("=").slice(1).join("=").toLowerCase();
  const got = COMPANIES.filter((c) => said.includes(c.toLowerCase()) || said.includes(slug(c)));
  const miss = want.filter((c) => !got.includes(c));
  const extra = got.filter((c) => !want.includes(c));
  if (miss.length || extra.length) return { ok: false, why: [miss.length ? `missed ${miss.join(", ")}` : "", extra.length ? `named ${extra.join(", ")}` : ""].filter(Boolean).join("; ") };
  return { ok: true, why: `all ${want.length} ${label}` };
}

// Interviews: seven customers need the product to keep working where there is
// no connection, each said in other words; six others touch networks, signal
// or working offline in ways that are not that need.
const NEED_OFFLINE: Plant[] = [
  { company: "Fenwick Marine", text: "Out on the vessels the crews go days without any link to shore, and they still log every job, so whatever we pick has to hold the entries until the boat is back in port." },
  { company: "Granger Farms", text: "The fields up the valley are dead zones for phones, so the pickers need to fill in the tallies out there and have them go through once they walk back to the yard." },
  { company: "Ironbridge Mining", text: "Our engineers spend most of a shift a long way below ground where nothing reaches them, and the checklists still have to open, take their answers and catch up when they come up top." },
  { company: "Kestrel Couriers", text: "On half the rural rounds the drivers' phones show no bars for an hour at a time, and a delivery note that only saves when the phone is online is no use to us." },
  { company: "Upland Forestry", text: "The crews are deep in the plantations all week with nothing on their phones, so the forms have to work on the tablet by themselves and send everything later." },
  { company: "Saltmarsh Fisheries", text: "The walls of the sheds on the quay are so thick the tablets drop off the wifi the moment you walk in, and the weigh-in sheets cannot wait for someone to find a spot by the door." },
  { company: "Glenmoor Water", text: "Half our pumping stations are up on the moors miles from any mast, and the inspectors must be able to finish the whole visit there and hand it in when they are back in the van." },
];
const NOT_OFFLINE: Plant[] = [
  { company: "Alder Logistics", text: "Our network team has to approve every new vendor, and the last review took them about six weeks, so plan for that." },
  { company: "Juniper Hotels", text: "Every hotel has fibre and good wifi in every room, so losing the connection is simply not something we worry about." },
  { company: "Northgate Security", text: "We have no use for any offline mode; all of our staff sit at desks in the control room with a cable in the wall." },
  { company: "Moorland Telecom", text: "Mobile coverage is our own business, so we will test your app on our network before anyone signs anything." },
  { company: "Crestfield Rail", text: "The connection we care about is the one to our accounting system; the sync with it has to run every few minutes." },
  { company: "Hartwell Events", text: "We ran an event in a field once with no signal at all, but that was years ago and we would never book a site like that again." },
];
const interviews: Corpus = {
  id: "interviews", dir: "interviews", seed: 4021, count: 36, plants: [...NEED_OFFLINE, ...NOT_OFFLINE],
  ask: (company, person, role) =>
    `Write a realistic transcript of a customer discovery interview, about 12,000 characters long. ${person} is the ${role} at ${company}, a small business; ` +
    `infer what it does from its name. Format: a first line "# Customer interview: ${company}", a line "Interviewee: ${person}, ${role}.", then alternating ` +
    `paragraphs "**Interviewer:** ..." and "**${person}:** ...", one paragraph per line with a blank line between. ${person}'s answers are long and concrete: ` +
    "how a normal week runs, quoting and invoicing, scheduling people and jobs, reports to management, customers and suppliers, tools tried before and why " +
    "they were dropped, what wastes time, what they would pay for. Give names, numbers and small stories. Never mention the internet, being online or offline, " +
    "wifi, phone signal, reception, coverage, networks of any kind, syncing, connections, remote or underground places, ships or boats. Every tool they describe " +
    "worked wherever they used it: never describe places where phones, tablets or apps stop working, nor entries failing to save, loading slowly or going missing. Plain text, no preamble.",
  scrub: /\b(internet|online|offline|wi-?fi|wireless|signal|reception|coverage|connect\w*|network\w*|broadband|[345]g|lte|mobile data|cellular|satellite|remote\w*|underground|below ground|vessels?|ships?|boats?|at sea|sync\w*|mast|bars|dead (zones?|spots?)|upload\w*|reach\w*|load\w*|barely work\w*|patchy|drops? out|no service|hopeless|basements?|spins?|vanish\w*|(keeps?|stops?|kept|stopped) working|los(e|es|ing|t)|farm tracks?|wherever)\b/i,
  joins: (l, person) => l.startsWith(`**${person}:**`),
};
export const readinterviews: Task = {
  id: "readinterviews",
  kind: "synthesize across many long files",
  prompt: "interviews/ holds the transcripts of our customer discovery interviews, one file per customer. Which customers said the product must keep working " +
    "where their people have no internet or mobile connection? Only customers who need that, not ones who merely mention networks or connections. " +
    "Do not change any file. Reply with one line exactly like: customers=<Company A, Company B, ...>",
  files: { "README.md": "# discovery\n\nInterview transcripts are in interviews/.\n" },
  async prepare(w, cache) { Object.assign(this.files, await build(interviews, w, cache)); },
  check: (_dir, reply) => checkSet(reply, NEED_OFFLINE.map((p) => p.company), "customers who need it"),
};

// Support notes: six customers say they may leave, each in other words; six
// others use the words of leaving (cancel, renewal, another vendor) for
// something else.
const WILL_LEAVE: Plant[] = [
  { company: "Birchwood Dental", text: "{person} mentioned that the partners have started booking demos with two of our competitors, and that if the booking screen freezes again in the morning rush they will pick one of them." },
  { company: "Holloway Print", text: "{person} has told their director that unless the invoice totals stop coming out wrong they should not sign up for another year, and the director agreed." },
  { company: "Oakhurst Vets", text: "{person} said they are at the end of their patience with the reminders that never go out, and that the practice group has already drawn up a shortlist of other systems." },
  { company: "Thornbury Legal", text: "{person} warned that if documents keep vanishing from the matter folders this will be their last year with us, and would rather say so now than at the review in March." },
  { company: "Bramley Solar", text: "Their board asked {person} to cost a move to someone else because the installer app keeps losing the site photos, and {person} has those numbers ready." },
  { company: "Vale Street Garages", text: "{person} passed on that the owners are asking why they pay for this when the parts orders keep failing, and want a plan from us by Friday or they will look around." },
];
const NOT_LEAVE: Plant[] = [
  { company: "Cobalt Roofing", text: "{person} explained they had to cancel two jobs last week because of the rain, which has nothing to do with the software but made the schedule look odd." },
  { company: "Dunmore Bakeries", text: "{person} asked us to renew the certificate on the ordering page before it runs out next month, since their shops saw the warning yesterday." },
  { company: "Elmstead Clinics", text: "{person} said they are moving another vendor's system out and putting everything into ours instead, so we should expect more users next quarter." },
  { company: "Pembury Plumbing", text: "{person} let us know one of their engineers is leaving at the end of the month and asked to move his jobs to the new starter." },
  { company: "Redfern Pharmacy", text: "{person} confirmed their renewal went through this morning for three more years and thanked us for sorting out the paperwork so fast." },
  { company: "Westcott Cleaning", text: "{person} told us a customer of theirs switched to a weekly contract with another cleaning firm, so their recurring jobs should close in the planner." },
];
const accounts: Corpus = {
  id: "accounts", dir: "accounts", seed: 7177, count: 30, plants: [...WILL_LEAVE, ...NOT_LEAVE],
  ask: (company, person, role) =>
    `Write one year of support notes for the customer account ${company}, a small business using our job management software; infer what it does from its name. ` +
    `About 12,000 characters. Format: a first line "# Support notes: ${company}", a line "Account contact: ${person}, ${role}.", then dated entries, ` +
    'each a line like "### 2026-02-14, phone call with ' + person + '" followed by one to three paragraphs, one paragraph per line, blank lines between. ' +
    "Mix how-to questions, bug reports with the steps tried, feature requests, billing questions, training sessions and small thanks, with names, numbers and details. " +
    "The customer is content overall. Never mention leaving, cancelling, renewals, contracts, competitors, other vendors or providers, switching, replacing, " +
    "notice periods, tenders or looking elsewhere. Plain text, no preamble.",
  scrub: /\b(leav\w*|left|cancel\w*|renew\w*|competitor\w*|switch\w*|alternative\w*|replac\w*|contract\w*|churn\w*|provider\w*|vendor\w*|terminat\w*|notice|tender\w*|elsewhere|quit\w*|shortlist\w*|demos?|look(ing)? around|someone else|another (system|company|firm)|other systems?|patience|frustrat\w*|unhappy|review)\b/i,
  joins: (l) => l.length > 200 && !l.startsWith("#"),
  frame: (text, person) => text.replaceAll("{person}", person),
};
export const readaccounts: Task = {
  id: "readaccounts",
  kind: "synthesize across many long files",
  prompt: "accounts/ holds this year's support notes, one file per customer account. Which customers have told us they may leave us for another provider or not renew? " +
    "Only customers at risk of leaving, not ones who use those words about something else. Do not change any file. Reply with one line exactly like: customers=<Company A, Company B, ...>",
  files: { "README.md": "# accounts\n\nSupport notes are in accounts/.\n" },
  async prepare(w, cache) { Object.assign(this.files, await build(accounts, w, cache)); },
  check: (_dir, reply) => checkSet(reply, WILL_LEAVE.map((p) => p.company), "customers at risk"),
};
