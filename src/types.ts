export interface NewsItem { externalId: string; url: string; title: string; summary: string; publishedAt: string | null }
export interface FeedState { etag?: string | null; lastModified?: string | null }
export interface SourceResult { items: NewsItem[]; notModified: boolean; etag: string | null; lastModified: string | null }
export interface SourceAdapter { kind: string; fetch(url: string, state: FeedState): Promise<SourceResult> }
export interface UserProfile { id: string; name: string; interests: string[]; excludedTopics: string[]; minScore: number; minConfidence: number; dailyLimit: number; timezone: string; quietStart: number; quietEnd: number; enabled: boolean }
export interface Decision { important: boolean; shouldPush: boolean; score: number; confidence: number; reason: string; summary: string; topics: string[] }
export interface Judge { evaluate(item: NewsItem, profile: UserProfile): Promise<Decision> }
export interface Env {
 DB: D1Database;
 ADMIN_TOKEN?: string;
 LLM_API_KEY?: string; LLM_BASE_URL?: string; LLM_MODEL?: string;
 PUSH_WEBHOOK_URL?: string; PUSH_WEBHOOK_TOKEN?: string;
 // Both flags default to false. Dry runs still use a paid LLM if enabled.
 LLM_ENABLED?: string; PUSH_ENABLED?: string;
}
