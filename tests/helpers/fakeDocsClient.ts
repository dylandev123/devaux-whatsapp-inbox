import { GoogleApiError, type DocsClient, type DriveFile } from "../../lib/server/aiAgent/googleDocs/google.ts";
import { tagsPresent } from "../../lib/aiAgent/gdocInsert.ts";
import { FakeApiError, type FakeGoogleDoc } from "./fakeGoogleDoc.ts";

const asGoogleError = (err: unknown): unknown => (err instanceof FakeApiError ? new GoogleApiError(err.kind as never, err.status, err.message, [], "Docs write") : err);

/** A DocsClient over in-memory documents. Counts calls so tests can prove what was (not) touched. */
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
    async probeDocsApi() {
      calls.push("probeDocsApi");
    },
    async batchUpdate(id, requests) {
      calls.push(`batchUpdate:${id}`);
      const d = doc(id);
      if (!d.canEdit) throw new GoogleApiError("forbidden", 403, "The caller does not have permission", [], "Docs write");
      try {
        d.applyBatch(requests);
      } catch (err) {
        throw asGoogleError(err);
      }
    },
    async findTags(id, refCodes) {
      calls.push(`findTags:${id}`);
      try {
        return tagsPresent(doc(id).readText(), refCodes);
      } catch (err) {
        throw err instanceof FakeApiError ? new GoogleApiError(err.kind as never, err.status, err.message, [], "Docs verify") : err;
      }
    },
  };
}
