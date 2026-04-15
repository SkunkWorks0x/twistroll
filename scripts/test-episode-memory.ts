import {
  ingestEpisode,
  queryMemory,
  formatMemoryBlock,
} from '../src/server/episodeMemory.js';

const SAMPLE_TRANSCRIPT = `
Jason: Alright, alright, alright — welcome back to This Week in Startups. I'm Jason Calacanis and today we've got Yazin from Sidecast, this insane multi-persona AI sidebar that watches a live podcast and fires off fact-checks and jokes in real time. Yazin, welcome to the show. How you doing, buddy.
Yazin: Thanks Jason, happy to be here. Big fan of the pod.
Jason: Okay so let me push back right off the bat — every founder who walks in here tells me they built "the AI sidebar for podcasts." What's different about Sidecast, give me the thirty second pitch.
Yazin: Sure. So we run five personas in round-robin — Not Jamie the fact checker, Not Delinquent the conspiracy guy, Not Taco the chihuahua comedian, Not Robin the news reader, and Not Fred the sound-effects producer. They each get about 800 milliseconds of latency end-to-end from when you finish a sentence.
Jason: Eight hundred milliseconds. I gotta be honest, that sounds like marketing — every voice AI company says sub-second latency and then when you actually demo it it's three seconds. What's your P99.
Yazin: P99 is one point four seconds. We're running a hybrid cloud plus local fallback — Claude on cloud for the hot path, Groq as the first fallback, then Ollama running locally as the safety net. We never go down even if the internet dies mid-show.
Jason: No seriously, that's actually impressive. What model are you running locally.
Yazin: Qwen 2.5 seven B for the troll personas, and a separate smaller fact checker model. The whole thing runs on an M3 Max without the fans even spinning up.
Jason: Whooooo! That's wild. Okay so what's the business model — are you selling this to podcasters, to networks, white-labeling it.
Yazin: Right now it's a bounty-based open source project. We raised about two hundred thousand in community bounties over the last six months. The idea is that sponsors can pay into bounties for specific features and the community ships them.
Jason: Two hundred K in bounties. God bless you. That's a real number. How big is the team.
Yazin: Two full time, three part time contractors. About seventy contributors total on the Discord.
Jason: Okay but here's where I push back again — bounty models historically don't scale. You look at Gitcoin, you look at the old Bountysource, none of those turned into real businesses. Why is this different.
Yazin: I think the difference is that we're not trying to be a bounty platform — we're just using bounties as our funding mechanism for one specific product. It's more like a Kickstarter with ongoing milestones.
Jason: That's a great question actually — I mean that's a great answer. So talk to me about OpenOats because that's the piece I find most interesting. That's the transcription layer underneath right.
Yazin: Yeah, OpenOats is our local speech-to-text engine. It runs on WhisperX, wraps it in a file-watcher architecture so any downstream tool — Sidecast, note-takers, translation — can just read the JSONL output. It writes a new line every time it detects a complete utterance.
Jason: And that's all local. No audio leaves the machine.
Yazin: Zero audio leaves. Not a single byte. We built it for creators who are paranoid about leaks before an episode airs — think guests who are under NDA or about to announce an acquisition.
Jason: That's huge. Holy shit, that's actually huge. What's the latency on OpenOats transcription itself.
Yazin: About two hundred and fifty milliseconds from end-of-utterance to JSONL write. It's basically real-time.
Jason: And you said embeddinggemma is part of this too right — for the memory layer.
Yazin: Yeah, we just added cross-episode memory using embeddinggemma via Ollama. Seven hundred sixty eight dimensional vectors, stored in LanceDB. The idea is that the personas can pull up callbacks from episodes six months ago — if a guest contradicts something they said on a previous show, Not Jamie will surface it.
Jason: Come again — you're telling me the fact checker can remember every episode back to like episode one.
Yazin: In theory, yeah. In practice we cap it at the last two years to keep queries under ten milliseconds.
Jason: Holy shit, that's actually insane. Okay last question before we wrap — what's the bounty you most want someone to pick up right now.
Yazin: The cross-episode memory integration is the big one — Phase 2, wiring it into the persona prompts so the trolls actually use it live. It's probably a forty hour job for someone who knows LanceDB and Node.
Jason: Forty hours. That's nothing. Alright, where can people find you.
Yazin: Sidecast dot dev, and the GitHub org is under SkunkWorks zero X.
Jason: Amazing. Yazin, thank you so much for coming on. This was fantastic. That's it for this week, see you Friday.
Yazin: Thanks Jason.
Jason: Whooo!
`.trim();

async function main() {
  console.log('═══ TWiSTroll Episode Memory — Phase 1 Test ═══\n');

  // 1. Ingest
  const ingestStart = Date.now();
  const chunkCount = await ingestEpisode({
    episodeNumber: 9999,
    episodeDate: '2026-04-06',
    episodeTitle: 'Test Episode — Sidecast Demo',
    guestName: 'Yazin',
    topicTags: ['AI', 'podcast tools', 'OpenOats'],
    transcriptText: SAMPLE_TRANSCRIPT,
    startTimestamp: 0,
  });
  const ingestMs = Date.now() - ingestStart;
  console.log(`[ingest] ${chunkCount} chunks inserted in ${ingestMs}ms`);
  console.log(`[ingest] transcript word count: ${SAMPLE_TRANSCRIPT.split(/\s+/).length}\n`);

  // 2. Unfiltered semantic query
  console.log('─── Query 1: "multi-persona AI sidebar for podcasts" ───');
  const q1Start = Date.now();
  const r1 = await queryMemory('multi-persona AI sidebar for podcasts');
  const q1Ms = Date.now() - q1Start;
  console.log(`[query] ${r1.length} results in ${q1Ms}ms`);
  r1.forEach((r, i) => {
    console.log(
      `  ${i + 1}. score=${r.score.toFixed(4)} [Ep ${r.episodeNumber} · ${r.guestName}] "${r.text.slice(0, 140).replace(/\s+/g, ' ')}..."`
    );
  });
  const topScore1 = r1[0]?.score ?? 0;

  console.log();

  // 3. Filtered query by guest
  console.log('─── Query 2: "what did Yazin say about OpenOats" {guestName: Yazin} ───');
  const q2Start = Date.now();
  const r2 = await queryMemory('what did Yazin say about OpenOats', 5, { guestName: 'Yazin' });
  const q2Ms = Date.now() - q2Start;
  console.log(`[query] ${r2.length} results in ${q2Ms}ms`);
  r2.forEach((r, i) => {
    console.log(
      `  ${i + 1}. score=${r.score.toFixed(4)} [Ep ${r.episodeNumber} · ${r.guestName}] "${r.text.slice(0, 140).replace(/\s+/g, ' ')}..."`
    );
  });
  const topScore2 = r2[0]?.score ?? 0;

  console.log();
  console.log('─── formatMemoryBlock() sample ───');
  console.log(formatMemoryBlock(r2));

  console.log();
  console.log('═══ SUMMARY ═══');
  console.log(`chunks ingested:    ${chunkCount}`);
  console.log(`ingest total:       ${ingestMs}ms`);
  console.log(`query 1 latency:    ${q1Ms}ms   top score: ${topScore1.toFixed(4)}`);
  console.log(`query 2 latency:    ${q2Ms}ms   top score: ${topScore2.toFixed(4)}`);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
