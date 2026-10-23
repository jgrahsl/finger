// Get-ready/work/rest interval sequencing: one beat per second, counted from
// the start of each phase. Phases with a length of 0 are skipped.
// config: { ready, work, rest } in seconds.

export function firstBeat(config) {
  return { phase: config.ready > 0 ? 'ready' : 'work', beat: 0, rep: 1 };
}

export function nextBeat(state, config) {
  if (state.beat + 1 < config[state.phase]) {
    return { ...state, beat: state.beat + 1 };
  }
  if (state.phase === 'ready') {
    return { phase: 'work', beat: 0, rep: state.rep };
  }
  if (state.phase === 'work' && config.rest > 0) {
    return { phase: 'rest', beat: 0, rep: state.rep };
  }
  return { phase: 'work', beat: 0, rep: state.rep + 1 };
}

/** The state `beats` beats after `state`. */
export function advance(state, config, beats) {
  for (let i = 0; i < beats; i++) state = nextBeat(state, config);
  return state;
}

/** Seconds left in the current phase, including the one this beat starts. */
export function remaining(state, config) {
  return config[state.phase] - state.beat;
}

/**
 * The rep number to show: the rep the current work belongs to, 0 while
 * getting ready, except in the last second before work, the moment of the
 * cue, which already shows the coming rep.
 */
export function shownRep(state, config) {
  const cue = state.phase !== 'work' && remaining(state, config) === 1;
  if (state.phase === 'ready') return cue ? state.rep : state.rep - 1;
  return cue ? state.rep + 1 : state.rep;
}

/**
 * Where this beat lies between two changes of the rep count, for a progress
 * bar that fills up just as the count goes up.
 *   kind     'ready' before the first rep; 'rep' from one cue before work to the next
 *   total    seconds in that stretch; elapsed: whole seconds of it already past
 *   parts    its stretches in order, as { kind: 'ready' | 'cue' | 'work' | 'rest', seconds }
 */
export function repProgress(state, config) {
  const cue = state.phase !== 'work' && remaining(state, config) === 1;
  if (state.phase === 'ready' && !cue) {
    const total = Math.max(1, config.ready - 1);
    return { kind: 'ready', total, elapsed: state.beat, parts: [{ kind: 'ready', seconds: total }] };
  }
  const stretch = repStretch(config);
  // Seconds since the cue, which is the last second of the rest (or of the
  // get-ready) before the work; without rests there is no cue.
  const lead = config.rest > 0 ? 1 : 0;
  const elapsed = cue ? 0 : state.phase === 'work' ? lead + state.beat : lead + config.work + state.beat;
  return { ...stretch, elapsed: Math.min(elapsed, stretch.total - 1) };
}

function repStretch(config) {
  const parts =
    config.rest > 0
      ? [
          { kind: 'cue', seconds: 1 },
          { kind: 'work', seconds: config.work },
          { kind: 'rest', seconds: config.rest - 1 },
        ]
      : [{ kind: 'work', seconds: config.work }];
  return { kind: 'rep', total: config.work + config.rest, elapsed: 0, parts: parts.filter((part) => part.seconds > 0) };
}

/** The bar before the timer is started: one rep, nothing done. */
export function idleRepProgress(config) {
  return repStretch(config);
}

// A rest only beeps for its final seconds, so long rests stay quiet.
const REST_BEEPS = 3;

/**
 * Which tone to play on this beat, or null for silence.
 *   work:        'start' on its first second, 'work' on the others
 *   rest:        'end' on its first beat, the moment work is over, so the
 *                signal to let go comes after the full work time
 *   ready, rest: 'prepare' then 'last' on the final two seconds before work;
 *                before that the phase's own tone ('rest' only for the
 *                third-last second, 'ready' throughout)
 */
export function toneFor(state, config) {
  if (state.phase === 'work') return state.beat === 0 ? 'start' : 'work';
  const left = remaining(state, config);
  if (left === 1) return 'last';
  if (state.phase === 'rest' && state.beat === 0) return 'end';
  if (left === 2) return 'prepare';
  if (state.phase === 'rest' && left > REST_BEEPS) return null;
  return state.phase;
}
