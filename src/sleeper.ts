// Sleeper public read API (no auth): https://docs.sleeper.com
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'https://api.sleeper.app/v1'

// The Ballers Fantasy League, 2026. Override via env for other leagues/seasons.
export const LEAGUE_ID = process.env.FF_LEAGUE_ID ?? '1385663706213388288'
export const USER_ID = process.env.FF_USER_ID ?? '1385762763669794816' // ramonfabrega
export const USERNAME = process.env.FF_USERNAME ?? 'ramonfabrega'

export async function api<T = any>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`sleeper GET ${path} → ${res.status}`)
  return res.json() as Promise<T>
}

export type Player = {
  player_id: string
  full_name?: string
  first_name?: string
  last_name?: string
  position?: string
  fantasy_positions?: string[]
  team?: string | null
  status?: string
  injury_status?: string | null
  age?: number
  years_exp?: number
  search_rank?: number
}

const CACHE_DIR = join(import.meta.dir, '../.cache')
const PLAYERS_TTL_MS = 24 * 60 * 60 * 1000

// ~5MB dump; Sleeper asks that it be fetched at most daily, so we cache to disk.
export async function players(): Promise<Record<string, Player>> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const file = Bun.file(join(CACHE_DIR, 'players.json'))
  if ((await file.exists()) && Date.now() - file.lastModified < PLAYERS_TTL_MS)
    return file.json()
  const data = await api<Record<string, Player>>('/players/nfl')
  await Bun.write(file, JSON.stringify(data))
  return data
}

export function playerName(p?: Player): string {
  if (!p) return '?'
  return p.full_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
}

export async function leagueUsers(leagueId: string) {
  const users = await api<any[]>(`/league/${leagueId}/users`)
  return Object.fromEntries(users.map((u) => [u.user_id, u]))
}
