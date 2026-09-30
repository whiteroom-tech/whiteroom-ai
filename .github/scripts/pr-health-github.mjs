// Minimal GitHub API client shared by the PR health scripts.

export function requireEnv(...keys) {
  for (const k of keys) {
    if (!process.env[k]) {
      console.error(`missing env ${k}`);
      process.exit(1);
    }
  }
}

export async function gh(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function paginate(path, key) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await gh(`${path}${sep}per_page=100&page=${page}`);
    const items = key ? data[key] : data;
    out.push(...items);
    if (items.length < 100) return out;
  }
}

export async function graphql(query, variables) {
  const res = await gh("/graphql", { method: "POST", body: { query, variables } });
  if (res.errors?.length) throw new Error(`GitHub GraphQL: ${res.errors.map((e) => e.message).join("; ")}`);
  return res.data;
}
