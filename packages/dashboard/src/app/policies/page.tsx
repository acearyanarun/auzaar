import { PolicyEditor } from "@/components/policy-editor/policy-editor";

export const dynamic = "force-dynamic";

export default function PoliciesPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Policy Editor</h1>
        <p className="text-sm text-zinc-400 mt-1">
          View and validate governance policies
        </p>
      </div>
      <PolicyEditor />
    </div>
  );
}
