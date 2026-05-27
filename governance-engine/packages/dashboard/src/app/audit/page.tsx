import { AuditLog } from "@/components/audit-log/audit-log";

export const dynamic = "force-dynamic";

export default function AuditPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Audit Log</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Immutable, hash-chained record of all governance events
        </p>
      </div>
      <AuditLog />
    </div>
  );
}
