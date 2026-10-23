export class GitHub {
  constructor({ token, url = 'https://api.github.com' }) {
    if (!token) throw new Error('GITHUB_TOKEN or GH_TOKEN is required');
    this.token = token;
    this.url = url.replace(/\/$/, '');
  }
  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
  async list(path) {
    const all = [];
    for (let page = 1; ; page++) {
      const batch = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }
}
