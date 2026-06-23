<script lang="ts">
  import { onMount } from "svelte";

  const apiKeyUrl =
    "https://platform.nova.datalabrotterdam.nl/dashboard/api-keys?name=Nova%20AI%20VSCode%20Extensie&scopes=models:read,llm:call";
  const docsUrl = "https://docs.datalabrotterdam.nl/services/nova-ai";

  type Theme = "light" | "dark" | "auto";
  const THEME_KEY = "theme";
  const THEME_OPTIONS: Theme[] = ["light", "dark", "auto"];

  let theme: Theme = "auto";

  function applyTheme(value: Theme) {
    const resolved =
      value === "auto"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : value;
    document.documentElement.setAttribute("data-theme", resolved);
  }

  function setTheme(value: Theme) {
    theme = value;
    localStorage.setItem(THEME_KEY, value);
    applyTheme(value);
  }

  function cycleTheme() {
    const next = THEME_OPTIONS[(THEME_OPTIONS.indexOf(theme) + 1) % THEME_OPTIONS.length];
    setTheme(next);
  }

  onMount(() => {
    theme = (localStorage.getItem(THEME_KEY) as Theme | null) ?? "auto";
    applyTheme(theme);

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (theme === "auto") applyTheme("auto");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  });

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
  <button class="theme-toggle" type="button" on:click={cycleTheme} title={`Theme: ${theme}`}>
    {#if theme === "light"}
      <svg viewBox="0 0 16 16" fill="currentColor"
        ><path
          d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 1.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zM8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0zm0 13.5a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2a.5.5 0 0 1 .5-.5zM2.343 2.343a.5.5 0 0 1 .707 0l1.414 1.414a.5.5 0 1 1-.707.707L2.343 3.05a.5.5 0 0 1 0-.707zm9.193 9.193a.5.5 0 0 1 .707 0l1.414 1.414a.5.5 0 0 1-.707.707l-1.414-1.414a.5.5 0 0 1 0-.707zM0 8a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2A.5.5 0 0 1 0 8zm13.5 0a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5zM2.343 13.657a.5.5 0 0 1 0-.707l1.414-1.414a.5.5 0 1 1 .707.707l-1.414 1.414a.5.5 0 0 1-.707 0zm9.193-9.193a.5.5 0 0 1 0-.707l1.414-1.414a.5.5 0 0 1 .707.707l-1.414 1.414a.5.5 0 0 1-.707 0z"
        /></svg
      >
    {:else if theme === "dark"}
      <svg viewBox="0 0 16 16" fill="currentColor"
        ><path
          d="M6 .278a.77.77 0 0 1 .08.858 7.2 7.2 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.79.79 0 0 1 .81.316.73.73 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z"
        /></svg
      >
    {:else}
      <svg viewBox="0 0 16 16" fill="currentColor"
        ><path
          d="M8 15A7 7 0 1 0 8 1zm0 1A8 8 0 1 1 8 0a8 8 0 0 1 0 16z"
        /></svg
      >
    {/if}
  </button>

  <div class="card">
    <div class="logo" aria-hidden="true">
      <svg viewBox="0 0 720 720" xmlns="http://www.w3.org/2000/svg">
        <g transform="translate(0,720) scale(0.1,-0.1)" fill="currentColor" stroke="none">
          <path d="M3280 7109 c-36 -5 -105 -14 -155 -20 -546 -65 -1154 -314 -1615 -663 -148 -112 -213 -170 -383 -341 -200 -201 -367 -416 -500 -640 -295 -501 -455 -1022 -484 -1577 -6 -117 -5 -128 12 -134 21 -8 483 11 605 26 172 20 375 61 394 81 6 5 20 9 33 9 13 0 31 4 41 9 9 5 35 14 57 21 22 7 73 28 113 47 39 18 74 33 77 33 3 0 24 12 48 27 23 15 60 36 82 47 162 84 418 333 520 506 6 10 16 24 22 31 22 28 132 238 153 294 20 53 57 147 69 178 5 12 12 33 15 47 2 14 9 41 15 60 5 19 15 55 22 80 6 25 15 54 20 65 4 11 10 38 13 60 21 166 37 218 64 213 12 -2 19 -17 24 -53 16 -111 41 -235 56 -280 22 -65 32 -102 32 -123 0 -11 5 -24 10 -27 6 -3 10 -14 10 -23 0 -15 36 -111 87 -232 69 -163 199 -360 325 -491 50 -53 165 -148 245 -202 67 -45 245 -139 321 -168 12 -5 32 -13 45 -19 29 -12 160 -54 217 -69 25 -7 59 -17 76 -22 17 -5 39 -9 49 -9 10 0 32 -4 49 -9 50 -16 137 -33 206 -43 243 -32 331 -40 660 -57 113 -6 277 -15 365 -21 109 -8 413 -10 955 -5 718 5 795 7 804 22 10 18 0 250 -15 358 -63 445 -159 756 -352 1141 -163 325 -354 588 -625 859 -290 291 -565 491 -910 664 -329 165 -740 291 -1082 331 -52 6 -129 15 -170 21 -90 11 -529 10 -620 -2z"/>
          <path d="M5285 3480 c-250 -11 -596 -33 -870 -55 -44 -4 -84 -11 -90 -16 -5 -5 -28 -9 -52 -9 -24 0 -69 -6 -101 -14 -113 -28 -153 -36 -177 -36 -13 0 -27 -4 -30 -10 -3 -5 -16 -10 -27 -10 -12 0 -35 -4 -52 -10 -127 -39 -202 -65 -210 -72 -6 -4 -16 -8 -24 -8 -28 0 -269 -123 -347 -177 -103 -72 -234 -181 -265 -222 -14 -18 -38 -47 -53 -64 -64 -74 -157 -220 -211 -332 -32 -66 -62 -128 -67 -137 -5 -10 -9 -23 -9 -30 0 -7 -11 -35 -25 -63 -13 -27 -25 -60 -25 -72 0 -12 -4 -24 -9 -27 -5 -3 -11 -20 -14 -38 -2 -18 -12 -58 -21 -88 -25 -81 -49 -197 -62 -297 -6 -44 -28 -73 -43 -57 -16 17 -31 77 -31 120 0 24 -4 46 -10 49 -5 3 -10 20 -10 37 0 18 -4 45 -9 62 -5 17 -17 58 -26 91 -9 33 -21 70 -26 83 -5 13 -9 32 -9 43 0 10 -5 28 -10 39 -6 11 -15 29 -20 40 -6 11 -10 26 -10 34 0 8 -6 27 -14 43 -8 15 -19 39 -24 53 -26 66 -82 179 -92 185 -5 3 -10 13 -10 21 0 9 -15 36 -33 62 -17 26 -36 54 -42 64 -72 119 -220 284 -340 378 -89 70 -107 83 -220 151 -62 37 -219 110 -280 129 -22 7 -48 16 -57 21 -10 5 -28 9 -41 9 -13 0 -27 4 -32 9 -6 5 -32 14 -60 21 -27 6 -68 16 -90 21 -136 35 -436 63 -737 70 -98 2 -111 1 -121 -16 -17 -30 7 -334 43 -545 32 -186 103 -433 185 -645 121 -308 323 -654 535 -915 98 -120 388 -408 501 -497 169 -133 191 -149 326 -235 390 -249 852 -425 1308 -498 398 -64 886 -52 1273 31 551 118 1049 356 1479 708 135 110 392 366 493 491 455 564 730 1264 766 1952 3 75 4 147 1 160 l-6 23 -788 1 c-433 1 -873 -2 -978 -6z"/>
        </g>
      </svg>
    </div>

    <h1>Connect Nova AI</h1>

    {#if status === "success"}
      <p class="success">Connected. You can close this tab and return to the terminal.</p>
    {:else}
      <p class="subtitle">Paste your DataLab Rotterdam Nova API key to connect nova-ai-cli.</p>

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

      <div class="help-links">
        <a class="help-button" href={apiKeyUrl} target="_blank" rel="noopener noreferrer">
          No API key? Create one
        </a>
        <a class="docs-link" href={docsUrl} target="_blank" rel="noopener noreferrer">
          Read the docs
        </a>
      </div>
    {/if}
  </div>
</main>

<style>
  :global([data-theme="dark"]) {
    --color-primary: #6633ee;
    --color-success: #4ade80;
    --color-danger: #ef4444;
    --color-text-primary: #e4e6eb;
    --color-text-secondary: #b0b3b8;
    --color-border-primary: #424242;
    --color-background-page: linear-gradient(150deg, #000000 0%, #0b0618 100%);
    --color-card-bg: rgba(18, 18, 18, 0.82);
    --color-card-border: rgba(255, 255, 255, 0.06);
    --color-input-bg: #1a1a1e;
  }

  :global([data-theme="light"]) {
    --color-primary: #6633ee;
    --color-success: #16a34a;
    --color-danger: #dc2626;
    --color-text-primary: #212529;
    --color-text-secondary: #5b5b5b;
    --color-border-primary: #e0e0df;
    --color-background-page: linear-gradient(150deg, #f0f0f0 0%, #ede8ff 100%);
    --color-card-bg: rgba(255, 255, 255, 0.78);
    --color-card-border: rgba(255, 255, 255, 0.6);
    --color-input-bg: #ffffff;
  }

  :global(html),
  :global(body) {
    margin: 0;
    min-height: 100dvh;
  }

  :global(body) {
    color: var(--color-text-primary);
    font-family:
      "Poppins",
      system-ui,
      -apple-system,
      sans-serif;
    background: var(--color-background-page);
    transition: background 0.2s, color 0.2s;
  }

  main {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    padding: 1.5rem;
  }

  .theme-toggle {
    position: absolute;
    top: 1.25rem;
    right: 1.25rem;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: 1px solid var(--color-border-primary);
    background: var(--color-card-bg);
    color: var(--color-text-primary);
    cursor: pointer;
    transition: 0.15s;
  }

  .theme-toggle:hover {
    opacity: 0.8;
  }

  .theme-toggle svg {
    width: 16px;
    height: 16px;
  }

  .card {
    width: 100%;
    max-width: 380px;
    padding: 2.5rem 2rem;
    border-radius: 1rem;
    background: var(--color-card-bg);
    border: 1px solid var(--color-card-border);
    box-shadow: 0 10px 20px rgba(0, 0, 0, 0.2);
    text-align: center;
  }

  .logo {
    width: 48px;
    height: 48px;
    margin: 0 auto 1.25rem;
    color: var(--color-text-primary);
  }

  .logo svg {
    width: 100%;
    height: 100%;
  }

  h1 {
    font-size: 1.25rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }

  .subtitle {
    color: var(--color-text-secondary);
    font-size: 0.875rem;
    margin-bottom: 1.5rem;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.65rem 0.85rem;
    border-radius: 0.75rem;
    border: 1px solid var(--color-border-primary);
    background: var(--color-input-bg);
    color: inherit;
    font-family: inherit;
    font-size: 0.925rem;
    transition: 0.15s;
  }

  input:focus {
    outline: none;
    border-color: var(--color-primary);
  }

  button[type="submit"] {
    padding: 0.65rem 1rem;
    border-radius: 0.75rem;
    border: none;
    background: var(--color-primary);
    color: white;
    font-family: inherit;
    font-weight: 500;
    font-size: 0.925rem;
    cursor: pointer;
    transition: 0.15s;
  }

  button[type="submit"]:hover:not(:disabled) {
    opacity: 0.85;
  }

  button[type="submit"]:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .success {
    color: var(--color-success);
    font-size: 0.925rem;
  }

  .error {
    color: var(--color-danger);
    font-size: 0.875rem;
    margin-top: 0.75rem;
  }

  .help-links {
    margin-top: 1.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--color-border-primary);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .help-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem 0.85rem;
    border-radius: 0.75rem;
    border: 1px solid var(--color-primary);
    color: var(--color-primary);
    font-size: 0.85rem;
    font-weight: 500;
    text-decoration: none;
    transition: 0.15s;
  }

  .help-button:hover {
    background: var(--color-primary);
    color: white;
  }

  .docs-link {
    font-size: 0.8rem;
    color: var(--color-text-secondary);
    text-decoration: underline;
  }
</style>
