import { isDeepStrictEqual } from 'node:util';
import type { SessionHistoryEvent, SessionHistoryEventDraft } from './history-domain';

export type HistoryEventAppendResult =
  | { readonly type: 'appended'; readonly event: SessionHistoryEvent; readonly evicted: readonly SessionHistoryEvent[] }
  | { readonly type: 'duplicate'; readonly event: SessionHistoryEvent }
  | { readonly type: 'collision'; readonly eventID: string };

export interface HistoryEventStore {
  append(input: { readonly draft: SessionHistoryEventDraft; readonly upstreamEventID?: string }): HistoryEventAppendResult;
  getRunEvents(runID: string): ReadonlyArray<SessionHistoryEvent>;
  getAllEvents(): ReadonlyArray<SessionHistoryEvent>;
  finishRun(runID: string): void;
}

export class InMemoryHistoryEventStore implements HistoryEventStore {
  private readonly maxEventsPerRun: number;
  private readonly eventsByRun = new Map<string, SessionHistoryEvent[]>();
  private readonly nextSeqByRun = new Map<string, number>();
  private readonly eventByID = new Map<string, SessionHistoryEvent>();

  constructor(options?: { readonly maxEventsPerRun?: number }) {
    this.maxEventsPerRun = options?.maxEventsPerRun ?? 5000;
  }

  append(input: { readonly draft: SessionHistoryEventDraft; readonly upstreamEventID?: string }): HistoryEventAppendResult {
    const { draft, upstreamEventID } = input;
    const { runID, type } = draft;
    const isTool = type === 'tool.started' || type === 'tool.finished';
    const hasUpstream = !isTool && upstreamEventID != null;

    let eventID: string;
    let seq: number | undefined;

    if (type === 'tool.started' || type === 'tool.finished') {
      const callID = draft.callID;
      const suffix = type === 'tool.started' ? 'started' : 'finished';
      eventID = `${runID}:tool:${callID}:${suffix}`;
    } else if (hasUpstream) {
      eventID = `${type}:${upstreamEventID}`;
    } else {
      seq = this.nextSeqByRun.get(runID) ?? 1;
      eventID = `${runID}:${type}:${seq}`;
    }

    const existing = this.eventByID.get(eventID);
    if (existing) {
      const candidate = { ...draft, eventID, sequence: existing.sequence } satisfies SessionHistoryEvent;
      if (isDeepStrictEqual(candidate, existing)) {
        return { type: 'duplicate', event: existing };
      }
      return { type: 'collision', eventID };
    }

    if (seq === undefined) {
      seq = this.nextSeqByRun.get(runID) ?? 1;
    }
    const event = {
      ...draft,
      eventID,
      sequence: seq
    } satisfies SessionHistoryEvent;

    const runEvents = this.eventsByRun.get(runID) ?? [];
    runEvents.push(event);
    this.eventsByRun.set(runID, runEvents);
    this.eventByID.set(eventID, event);
    const next = seq + 1;
    this.nextSeqByRun.set(runID, next);

    const evicted = this.evictIfNeeded(runID);

    return { type: 'appended', event, evicted };
  }

  private evictIfNeeded(runID: string): SessionHistoryEvent[] {
    const events = this.eventsByRun.get(runID);
    if (!events) return [];
    const evicted: SessionHistoryEvent[] = [];
    while (events.length > this.maxEventsPerRun) {
      const oldest = events.shift();
      if (!oldest) break;
      this.eventByID.delete(oldest.eventID);
      evicted.push(oldest);
    }
    return evicted;
  }

  getRunEvents(runID: string): ReadonlyArray<SessionHistoryEvent> {
    const events = this.eventsByRun.get(runID) ?? [];
    return [...events];
  }

  getAllEvents(): ReadonlyArray<SessionHistoryEvent> {
    const all: SessionHistoryEvent[] = [];
    for (const events of this.eventsByRun.values()) {
      all.push(...events);
    }
    all.sort((a, b) =>
      a.timestampMs - b.timestampMs ||
      a.sessionID.localeCompare(b.sessionID) ||
      a.runID.localeCompare(b.runID) ||
      a.sequence - b.sequence
    );
    return all;
  }

  restore(events: readonly SessionHistoryEvent[]): {
    readonly restored: readonly SessionHistoryEvent[];
    readonly rejected: readonly SessionHistoryEvent[];
    readonly evicted: readonly SessionHistoryEvent[];
  } {
    if (this.eventByID.size > 0 || this.nextSeqByRun.size > 0) {
      return { restored: [], rejected: [...events], evicted: [] };
    }
    const byEventID = new Map<string, SessionHistoryEvent[]>();
    const bySlot = new Map<string, SessionHistoryEvent[]>();
    for (const ev of events) {
      const idList = byEventID.get(ev.eventID) ?? [];
      idList.push(ev);
      byEventID.set(ev.eventID, idList);
      const slotKey = `${ev.runID}:${ev.sequence}`;
      const slotList = bySlot.get(slotKey) ?? [];
      slotList.push(ev);
      bySlot.set(slotKey, slotList);
    }

    const rejectedSet = new Set<SessionHistoryEvent>();
    for (const [, list] of byEventID) {
      const first = list[0];
      const allSame = list.every(e => isDeepStrictEqual(e, first));
      if (!allSame) {
        for (const e of list) rejectedSet.add(e);
      }
    }
    for (const [, list] of bySlot) {
      if (list.length > 1) {
        const first = list[0];
        const allSame = list.every(e => isDeepStrictEqual(e, first));
        if (!allSame) {
          for (const e of list) rejectedSet.add(e);
        }
      }
    }

    const accepted: SessionHistoryEvent[] = [];
    const seenAcceptedEventIDs = new Set<string>();
    for (const ev of events) {
      if (!rejectedSet.has(ev) && !this.eventByID.has(ev.eventID) && !seenAcceptedEventIDs.has(ev.eventID)) {
        seenAcceptedEventIDs.add(ev.eventID);
        accepted.push(ev);
      }
    }

    accepted.sort((a, b) =>
      a.runID.localeCompare(b.runID) ||
      a.sequence - b.sequence ||
      a.eventID.localeCompare(b.eventID)
    );

    const restored: SessionHistoryEvent[] = [];
    const perRunAccepted = new Map<string, SessionHistoryEvent[]>();
    for (const ev of accepted) {
      const list = perRunAccepted.get(ev.runID) ?? [];
      list.push(ev);
      perRunAccepted.set(ev.runID, list);
    }

    const evicted: SessionHistoryEvent[] = [];
    for (const [runID, list] of perRunAccepted) {
      const maxSeq = list.reduce((m, e) => Math.max(m, e.sequence), 0);
      const currentNext = this.nextSeqByRun.get(runID) ?? 1;
      if (maxSeq + 1 > currentNext) {
        this.nextSeqByRun.set(runID, maxSeq + 1);
      }
      list.sort((a, b) => a.sequence - b.sequence || a.eventID.localeCompare(b.eventID));
      const runEvents = this.eventsByRun.get(runID) ?? [];
      const evictCount = list.length > this.maxEventsPerRun ? list.length - this.maxEventsPerRun : 0;
      const toEvict = list.slice(0, evictCount);
      const toKeep = list.slice(evictCount);
      for (const ev of toEvict) {
        evicted.push(ev);
      }
      for (const ev of toKeep) {
        runEvents.push(ev);
        this.eventByID.set(ev.eventID, ev);
        restored.push(ev);
      }
      if (runEvents.length > 0) {
        this.eventsByRun.set(runID, runEvents);
      }
    }

    const rejected = Array.from(rejectedSet);
    return { restored, rejected, evicted };
  }

  finishRun(runID: string): void {
    this.evictIfNeeded(runID);
  }
}
