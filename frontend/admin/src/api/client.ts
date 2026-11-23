import type { components } from "./schema";

export type Schemas = components["schemas"];

const TENANT_KEY = "aich.tenant";

/** The tenant comes from `?tenant=` (first visit) and is kept in localStorage. */
export function tenantId(): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get("tenant");
  try {
    if (fromQuery) localStorage.setItem(TENANT_KEY, fromQuery);
    return fromQuery ?? localStorage.getItem(TENANT_KEY);
  } catch {
    return fromQuery;
  }
}

export function loginUrl(tenant: string): string {
  const next = encodeURIComponent(window.location.href);
  return `/auth/login?tenant_id=${encodeURIComponent(tenant)}&next=${next}`;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function detail(body: unknown, status: number): string {
  if (body && typeof body === "object" && "detail" in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map((e) => (e as { msg?: string }).msg ?? String(e)).join("; ");
  }
  return `HTTP ${status}`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (response.status === 401) {
    const tenant = tenantId();
    if (tenant) window.location.assign(loginUrl(tenant));
    throw new ApiError(401, "Not logged in");
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, detail(body, response.status));
  return body as T;
}

export const send = <T>(method: string, path: string, body?: unknown) =>
  api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
