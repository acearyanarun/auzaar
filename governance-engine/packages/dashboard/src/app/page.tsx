import { ReviewQueue } from "@/components/review-queue/review-queue";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Review Queue</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Flagged transactions awaiting operator review
        </p>
      </div>
      <ReviewQueue />
    </div>
  );
}
