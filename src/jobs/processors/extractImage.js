import { randomUUID } from 'crypto';
import { getJob, updateJob, supabase } from '../../services/supabase.js';
import { generateDecorationImage } from '../../services/openai.js';
import { getObjectBuffer, putObject } from '../../services/r2.js';
import { jobQueue } from '../queue.js';

// Enqueue the "Extract Elements" phase-2 regeneration. Single chokepoint for the job name, matching
// the convention of the other processors (removeLogoBg, optimizePhoto).
export function enqueueExtractImage(jobId) {
  if (!jobId) return;
  return jobQueue.add('extract_image', { jobId });
}

// The raw provider error is a wall of JSON, and it lands verbatim on a card in the admin UI. Turn the
// one failure we actually expect into a sentence a human can act on.
//
// Moderation is the interesting case: the model refuses licensed characters and brand logos, and it
// checks at the OUTPUT stage — so the image is generated and billed, THEN blocked. We now catch most
// of these at identify time (they never reach this job), but the flag isn't perfect, so anything that
// slips through should still explain itself rather than dumping `moderation_blocked` at the admin.
function humanError(message) {
  const raw = String(message ?? '');
  if (/moderation_blocked|safety system/i.test(raw)) {
    return "The image model refused to generate this — it usually means the decoration is a licensed character, a brand logo, or otherwise copyrighted. It can't be added to the library.";
  }
  if (/rate.?limit|429/i.test(raw)) {
    return 'The image model was rate-limited. Try regenerating this one again in a minute.';
  }
  // Unknown failure: keep the provider's words (they're the only clue) but bound the length so one
  // bad response can't blow out the card.
  return raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
}

// Regenerate each selected decoration as a clean, isolated library asset.
//
// Per candidate: take the crop phase 1 already stored → run a gpt-image EDIT conditioned on that
// crop → store the PNG in R2 and point the row at it.
//
// NOTE what this deliberately does NOT do: background removal. We ask the model for a transparent
// background and it obliges, but even when it doesn't, this is the wrong place to fix it — a
// candidate is not an element yet, and most candidates never become one. Background removal belongs
// in the ONE place it already lives, the standard 2D pipeline in AddElement, which runs when the
// admin actually saves a decoration as an element. So we pay for it per KEEPER, not per generation,
// and there is a single code path that cuts out a 2D element rather than two.
//
// One candidate failing must never sink the others (they are independent, and the admin may still
// want the rest), so each is wrapped: a failure marks THAT row 'failed' with a reason the UI shows,
// and the job still completes.
//
// Images go to R2, never into the jobs row. (The previous version of this file assigned a raw Buffer
// to a field called `url` and wrote it into the `jobs.result` jsonb column — that would have stuffed
// megabytes of `{"type":"Buffer","data":[…]}` into a DB row per decoration. It never ran, because
// nothing ever called the route, but it would not have worked if it had.)
export async function extractImage({ jobId }) {
  await updateJob(jobId, 'processing');
  try {
    const job = await getJob(jobId);
    const ids = job.payload?.candidateIds ?? [];
    if (!ids.length) throw new Error('job payload has no candidateIds');

    const { data: candidates, error } = await supabase
      .from('element_candidates').select('*').in('id', ids);
    if (error) throw new Error(error.message);

    // Sequential, not Promise.all: gpt-image is rate-limited by IMAGES per minute (5/min on tier 1),
    // so firing five edits at once is the reliable way to eat a 429. This is a background job — the
    // admin is not blocked on it — so throughput is worth less here than not failing.
    let ready = 0;
    for (const c of candidates ?? []) {
      try {
        const reference = await getObjectBuffer(c.crop_key || c.source_key);
        const generated = await generateDecorationImage(reference, c.prompt || c.label || 'a cake decoration');

        const outputKey = `elements/candidates/outputs/${randomUUID()}.png`;
        await putObject(outputKey, generated, 'image/png');

        await supabase.from('element_candidates').update({
          output_key: outputKey,
          status:     'ready',
          error:      null,
          updated_at: new Date().toISOString(),
        }).eq('id', c.id);
        ready++;
      } catch (err) {
        console.error(`extract_image: candidate "${c.label}" (${c.id}) failed:`, err.message);
        await supabase.from('element_candidates').update({
          status:     'failed',
          error:      humanError(err.message),
          updated_at: new Date().toISOString(),
        }).eq('id', c.id);
      }
    }

    // The result is a SUMMARY only — the candidate rows are the real output and are already written.
    await updateJob(jobId, 'done', { result: { ready, failed: (candidates?.length ?? 0) - ready } });
  } catch (err) {
    // The job itself blew up (bad payload, DB unreachable). Release any candidate still parked in
    // 'generating', or the UI would poll a spinner forever on a job that is never coming back.
    await supabase
      .from('element_candidates')
      .update({ status: 'failed', error: err.message, updated_at: new Date().toISOString() })
      .eq('job_id', jobId)
      .eq('status', 'generating');
    await updateJob(jobId, 'failed', { error: err.message });
  }
}
