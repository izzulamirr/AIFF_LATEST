import { login, signup } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const params = await searchParams;

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-semibold">Sign in to EASY</h1>

      {params.error && <p className="rounded bg-red-100 p-2 text-sm text-red-800">{params.error}</p>}
      {params.message && <p className="rounded bg-blue-100 p-2 text-sm text-blue-800">{params.message}</p>}

      <form className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input name="email" type="email" required className="rounded border px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input name="password" type="password" required minLength={8} className="rounded border px-3 py-2" />
        </label>
        <div className="flex gap-2">
          <button formAction={login} className="flex-1 rounded bg-black px-4 py-2 text-white">
            Log in
          </button>
          <button formAction={signup} className="flex-1 rounded border px-4 py-2">
            Sign up
          </button>
        </div>
      </form>
    </div>
  );
}
