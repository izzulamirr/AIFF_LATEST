import Link from "next/link";
import { eq } from "drizzle-orm";
import { documents, extractionJobs, projects } from "@easy/db";
import { getDb } from "@/lib/db";
import { MAX_UPLOAD_MB } from "@/lib/uploadLimits";
import { deleteDocument, uploadDocument } from "./actions";
import { DeleteDocumentButton } from "./DeleteDocumentButton";

const DOC_TYPE_LABELS: Record<string, string> = {
  pid: "P&ID",
  hmb: "H&MB",
  pfd: "PFD",
  spec_sheet: "Spec Sheet",
  iso: "ISO",
  ga: "GA",
  pll: "Line List (PLL)",
  pid_legend: "P&ID Legend",
};

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return <p>Project not found.</p>;

  const projectDocuments = await db.select().from(documents).where(eq(documents.projectId, id));

  const projectJobs = await db
    .select({ job: extractionJobs })
    .from(extractionJobs)
    .innerJoin(documents, eq(documents.id, extractionJobs.documentId))
    .where(eq(documents.projectId, id));
  const jobsByDocument = new Map<string, (typeof projectJobs)[number]["job"]>();
  for (const { job } of projectJobs) {
    const existing = jobsByDocument.get(job.documentId);
    if (!existing || job.createdAt > existing.createdAt) jobsByDocument.set(job.documentId, job);
  }

  async function handleUpload(formData: FormData) {
    "use server";
    await uploadDocument(id, formData);
  }

  async function handleLegendUpload(formData: FormData) {
    "use server";
    formData.set("docType", "pid_legend");
    await uploadDocument(id, formData);
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">{project.name}</h1>

      <div className="flex flex-wrap gap-4">
        <form action={handleUpload} className="flex max-w-md flex-col gap-2 rounded border p-4">
          <label className="text-sm">
            Document type
            <select name="docType" required className="mt-1 block w-full rounded border px-3 py-2">
              <option value="pid">P&ID</option>
              <option value="hmb">H&MB</option>
              <option value="pfd">PFD</option>
              <option value="spec_sheet">Spec Sheet</option>
              <option value="iso">ISO</option>
              <option value="ga">GA</option>
              <option value="pll">Line List (PLL)</option>
            </select>
          </label>
          <label className="text-sm">
            PDF, CSV, or XLSX file (max {MAX_UPLOAD_MB} MB)
            <input type="file" name="file" accept="application/pdf,.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required className="mt-1 block w-full" />
          </label>
          <button className="rounded bg-black px-4 py-2 text-white">Upload</button>
        </form>

        <form action={handleLegendUpload} className="flex max-w-md flex-col gap-2 rounded border p-4">
          <p className="text-sm font-medium">Upload P&ID Legend</p>
          <p className="text-xs text-gray-500">
            This project&apos;s symbol/abbreviation key. Upload it once per project (before other P&IDs, if possible) -- other
            P&amp;IDs in this project will read their valve/instrument symbols against it.
          </p>
          <label className="text-sm">
            PDF file (max {MAX_UPLOAD_MB} MB)
            <input type="file" name="file" accept="application/pdf" required className="mt-1 block w-full" />
          </label>
          <button className="rounded bg-black px-4 py-2 text-white">Upload legend</button>
        </form>
      </div>

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b">
            <th className="py-2">File</th>
            <th>Type</th>
            <th>Pages</th>
            <th>Extraction status</th>
            <th className="w-px"></th>
          </tr>
        </thead>
        <tbody>
          {projectDocuments.map((doc) => {
            const job = jobsByDocument.get(doc.id);
            return (
              <tr key={doc.id} className="border-b">
                <td className="py-2">
                  {job?.status === "succeeded" ? (
                    <Link href={`/projects/${id}/documents/${doc.id}`} className="text-blue-600 underline">
                      {doc.fileName}
                    </Link>
                  ) : (
                    doc.fileName
                  )}
                </td>
                <td>{DOC_TYPE_LABELS[doc.docType] ?? doc.docType}</td>
                <td>{doc.pageCount ?? "-"}</td>
                <td>
                  {job ? (
                    <span>
                      {job.status}
                      {job.status === "running" && job.progressPhase ? ` (${job.progressPhase} ${job.progressCurrent ?? "?"}/${job.progressTotal ?? "?"})` : ""}
                      {job.status === "failed" && job.errorMessage ? `: ${job.errorMessage}` : ""}
                    </span>
                  ) : (
                    "no job"
                  )}
                </td>
                <td className="py-2 text-right">
                  <DeleteDocumentButton
                    fileName={doc.fileName}
                    onDelete={async () => {
                      "use server";
                      await deleteDocument(id, doc.id);
                    }}
                  />
                </td>
              </tr>
            );
          })}
          {projectDocuments.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-gray-500">
                No documents uploaded yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
