<script lang="ts">
  let apiKey = "";
  let status: "idle" | "submitting" | "success" | "error" = "idle";
  let errorMessage = "";

  async function submit() {
    status = "submitting";
    errorMessage = "";

    try {
      const res = await fetch("/api/authenticate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        errorMessage = body?.message ?? "Failed to validate API key.";
        status = "error";
        return;
      }

      status = "success";
    } catch {
      errorMessage = "Could not reach the local auth server.";
      status = "error";
    }
  }
</script>

<main>
  <h1>Connect Nova AI</h1>

  {#if status === "success"}
    <p class="success">Connected. You can close this tab and return to the terminal.</p>
  {:else}
    <p>Paste your DataLab Rotterdam Nova API key to connect nova-ai-cli.</p>

    <form on:submit|preventDefault={submit}>
      <input
        type="password"
        bind:value={apiKey}
        placeholder="Nova API key"
        autocomplete="off"
        required
        disabled={status === "submitting"}
      />
      <button type="submit" disabled={status === "submitting" || !apiKey}>
        {status === "submitting" ? "Connecting…" : "Connect"}
      </button>
    </form>

    {#if status === "error"}
      <p class="error">{errorMessage}</p>
    {/if}
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0f0f12;
    color: #e6e6e6;
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
  }

  main {
    max-width: 360px;
    margin: 10vh auto;
    padding: 2rem;
  }

  h1 {
    font-size: 1.25rem;
    margin-bottom: 0.5rem;
  }

  form {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    border: 1px solid #333;
    background: #1a1a1e;
    color: inherit;
  }

  button {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    border: none;
    background: #5b5bf0;
    color: white;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .success {
    color: #4ade80;
  }

  .error {
    color: #f87171;
  }
</style>
