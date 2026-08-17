import Link from "next/link";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-3xl font-semibold">EASY</h1>
      <p className="max-w-md text-gray-600">
        AI-powered cross-document engineering review -- P&amp;ID, H&amp;MB, PFD, and spec sheet consistency checking.
      </p>
      <Link href="/login" className="rounded bg-black px-5 py-2 text-white">
        Sign in
      </Link>
    </div>
  );
}
