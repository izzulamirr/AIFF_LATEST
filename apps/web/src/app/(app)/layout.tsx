import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { signOut } from "./actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  return (
    <div className="min-h-screen">
      <nav className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex gap-4">
          <Link href="/dashboard" className="font-semibold">
            EASY
          </Link>
          <Link href="/projects">Projects</Link>
          <Link href="/cross-check">Cross check</Link>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-500">{user.email}</span>
          <form action={signOut}>
            <button className="underline">Sign out</button>
          </form>
        </div>
      </nav>
      <main className="p-6">{children}</main>
    </div>
  );
}
