/**
 * Browser-side fetch client for the plugin's host routes. Plain fetch against
 * same-origin paths; every failure resolves to `{ ok: false, ... }` so callers
 * branch without try/catch.
 */

import type {
  CreateBody, CreateResult, InspectBody, InspectResult, ListBody, ListResult, MergeBody, MergeResult, RemoveBody, RemoveResult,
  RepoStatus, RouteError, SquashMessageBody, SquashMessageResult, SwitchBody, SwitchResult,
} from '../wire.ts'
import {
  ROUTE_CREATE, ROUTE_INSPECT, ROUTE_LIST, ROUTE_MERGE, ROUTE_REMOVE, ROUTE_SQUASH_MESSAGE, ROUTE_STATUS, ROUTE_SWITCH,
} from '../wire.ts'

/** One route call outcome: the parsed body, or the error envelope. */
export type Call<T> = (T & { ok: true }) | ({ ok: false } & RouteError)

/** POST one JSON body and parse the uniform envelope. */
async function post<T>(url: string, body: unknown): Promise<Call<T>> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      // An empty or non-JSON body (a host that has not loaded this build yet).
      return { ok: false, error: `HTTP ${String(response.status)}` }
    }
    if (!response.ok) {
      const error = payload as Partial<RouteError>
      return { ...error, ok: false, error: error.error ?? `HTTP ${String(response.status)}` }
    }
    return { ...(payload as T), ok: true }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * Repository status for one directory.
 * @param path - absolute directory.
 */
export async function fetchStatus(path: string): Promise<Call<RepoStatus>> {
  try {
    const response = await fetch(`${ROUTE_STATUS}?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
    if (!response.ok) return { ok: false, error: `HTTP ${String(response.status)}` }
    return { ...(await response.json() as RepoStatus), ok: true }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

export const requestSwitch = (body: SwitchBody): Promise<Call<SwitchResult>> => post(ROUTE_SWITCH, body)
export const requestCreate = (body: CreateBody): Promise<Call<CreateResult>> => post(ROUTE_CREATE, body)
export const requestList = (body: ListBody): Promise<Call<ListResult>> => post(ROUTE_LIST, body)
export const requestInspect = (body: InspectBody): Promise<Call<InspectResult>> => post(ROUTE_INSPECT, body)
export const requestMerge = (body: MergeBody): Promise<Call<MergeResult>> => post(ROUTE_MERGE, body)
export const requestRemove = (body: RemoveBody): Promise<Call<RemoveResult>> => post(ROUTE_REMOVE, body)
export const requestSquashMessage = (body: SquashMessageBody): Promise<Call<SquashMessageResult>> => post(ROUTE_SQUASH_MESSAGE, body)
