/**
 * The bwat backend routes the plugin's tools read, typed, on the one API client. Paths and shapes
 * are the backend README's (Identity; Meetings and transcripts; Client sessions, hand-offs and the
 * inbox). The types describe what the backend sends; nothing here checks them.
 */
import type { ApiClient } from './client.js';

export interface Member {
  id: string;
  email: string;
  display_name: string | null;
  role: 'owner' | 'admin' | 'member';
}

export interface InboxMessage {
  id: string;
  message_type: 'handoff';
  created_at: string;
  read_at: string | null;
  target_client_session: string;
  source: { kind: 'card' | 'todo'; id: string; occurrence_id?: string };
  handoff_id: string;
  subject: string;
  /** Only from inboxMessage. */
  body?: string;
}

/** next_cursor is left out on the last page. */
export interface InboxPage {
  messages: InboxMessage[];
  next_cursor?: string;
}

export interface Meeting {
  id: string;
  occurrence_id: string;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  attendee_count: number | null;
  transcript_available: boolean;
  finalization: 'open' | 'transcript_complete';
}

export interface Transcript {
  meeting_id: string;
  occurrence_id: string;
  finalization: 'open' | 'transcript_complete';
  complete: boolean;
  occurrence_state: 'live' | 'ended' | 'abandoned';
  segments: {
    epoch: number;
    seq: number;
    speaker: { label: string; member_id: string | null };
    text: string;
    start_ms: number;
    end_ms: number;
    source: 'asr' | 'chat';
  }[];
  next_cursor: string | null;
}

/** How bwat lists a session as a hand-off target. */
export interface SessionClient {
  kind: 'claude-code' | 'codex';
  wake: 'push' | 'pull';
  machine: string;
  platform: string;
  plugin_version: string;
  cwd: string;
  name?: string;
  keywords?: string[];
}

/** One sending of bwat to a meeting (the backend's allocation view). */
export interface Allocation {
  id: string;
  meeting_number: string;
  occurrence_id: string | null;
  claim_state: string;
  refused_reason: string | null;
  error: string | null;
  settings: Record<string, unknown>;
}

export interface InboxQuery {
  scope?: 'session' | 'all';
  client_session?: string;
  unread_only?: boolean;
  cursor?: string;
}

export function bwatApi(client: ApiClient) {
  return {
    me: () => client.get(['me']) as Promise<Member>,
    inbox: (query: InboxQuery) => client.get(['me', 'inbox'], { ...query }) as Promise<InboxPage>,
    inboxMessage: (id: string) => client.get(['me', 'inbox', id]) as Promise<InboxMessage>,
    markRead: (id: string) => client.patch(['me', 'inbox', id]) as Promise<{ id: string; read_at: string }>,
    meetings: (query: { cursor?: string }) =>
      client.get(['meetings'], query) as Promise<{ meetings: Meeting[]; next_cursor: string | null }>,
    /** By our meeting id or by the Zoom occurrence, which the client URL-encodes as one segment. */
    transcript: (meeting: string, query: { cursor?: string; limit?: number; tail?: number }) =>
      client.get(['meetings', meeting, 'transcript'], query) as Promise<Transcript>,
    /** Where bwat is sent, live and recent (GET /allocations). */
    allocations: () => client.get(['allocations']) as Promise<{ allocations: Allocation[] }>,
    /** Send bwat to the meeting a Zoom link names; the link's passcode comes with it. */
    join: (zoomUrl: string) => client.post(['allocations'], { zoom_url: zoomUrl }) as Promise<Allocation>,
    /** Recall bwat from one meeting. */
    recall: (allocationId: string) => client.patch(['allocations', allocationId], { recall: true }) as Promise<Allocation>,
    /** One meeting's cards, from the card service behind the same address. */
    cards: (meetingId: string) => client.get(['occurrences', meetingId, 'cards']) as Promise<unknown[]>,
    /** Registers, heartbeats or (ended) ends one of the caller's sessions. */
    putSession: (id: string, body: { client: SessionClient; instance_id: string; ended: boolean }) =>
      client.put(['sessions', id], body) as Promise<unknown>,
  };
}

export type BwatApi = ReturnType<typeof bwatApi>;
