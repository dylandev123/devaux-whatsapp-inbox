// Server-only: the business's known chats for the AI agent pickers, read with
// the service role (admin routes only). See lib/aiAgent/chatSources.ts for
// the sources and the business_slug filtering.

import { BusinessChats, loadBusinessChats as load } from "@/lib/aiAgent/chatSources";
import { agentDb } from "@/lib/server/aiAgent/db";

export type { BusinessChats };

export function loadBusinessChats(businessSlug: string): Promise<BusinessChats> {
  return load(agentDb(), businessSlug);
}
