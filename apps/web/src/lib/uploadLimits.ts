// Upload size limit, shared by the upload server action (which rejects
// oversized files with a readable message) and the upload forms (which show
// the limit to the user). Keep in step with next.config.ts's
// serverActions.bodySizeLimit and the Supabase "documents" bucket's own
// file_size_limit -- the smallest of the three is what a user actually hits.
// Lives outside actions.ts because a "use server" module may only export
// async functions.
export const MAX_UPLOAD_MB = 10;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
