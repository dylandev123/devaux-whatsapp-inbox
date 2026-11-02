import { GoogleApiError, type DocsClient, type DriveFile } from "../../lib/server/aiAgent/googleDocs/google.ts";
import { FakeApiError, type FakeGoogleDoc } from "./fakeGoogleDoc.ts";

/** A DocsClient over an in-memory document. Counts calls so tests can prove what was (not) touched. */
export function fakeClient(docs: Record<string, FakeGoogleDoc>): DocsClient & { calls: string[] } {
  const calls: string[] = [];
  const doc = (id: string): FakeGoogleDoc => {
    const d = docs[id];
    if (!d) throw new GoogleApiError("not_found", 404, "Requested entity was not found.");
    return d;
  };
  return {
    calls,
    async getFile(id): Promise<DriveFile> {
      calls.push(`getFile:${id}`);
      const d = doc(id);
      return { id, name: d.title, mimeType: d.mimeType, trashed: d.trashed, canEdit: d.canEdit };
    },
    async getDocument(id) {
      calls.push(`getDocument:${id}`);
      return doc(id).toDocument();
    },
    async batchUpdate(id, requests, requiredRevisionId) {
      calls.push(`batchUpdate:${id}`);
      const d = doc(id);
      if (!d.canEdit) throw new GoogleApiError("forbidden", 403, "The caller does not have permission");
      try {
        d.applyBatch(requests, requiredRevisionId);
      } catch (err) {
        if (err instanceof FakeApiError) throw new GoogleApiError(err.kind as never, err.status, err.message);
        throw err;
      }
    },
  };
}
