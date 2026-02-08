# Altus Commonware Research MCP

An MCP server designed to act as an architectural advisor for the **Commonware** blockchain infrastructure. It connects to Altus's Notion workspace to retrieve, synthesize, and present research and design documentation, specifically focusing on Commonware and Reth.

## Connect to MCP
Configure your client to connect to the MCP endpoint:
`https://altus-commonware-research.onrender.com/mcp`

### claudecode
For claudecode, add underlying config to settings.json
```json
{
  "mcpServers": {
    "altus-research": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://altus-commonware-research.onrender.com/mcp"
      ]
    }
  }
}
```

### gemini-cli
For gemini-cli, add underlying config to settings.json
```json
{
  "mcpServers": {
    "altus-research": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://altus-commonware-research.onrender.com/mcp"
      ]
    }
  }
}
```

### codex-cli
For codex-cli, add underlying config to config.toml
```toml
[mcp_servers.altus-research]
command = "npx"
args = [
  "-y",
  "mcp-remote",
  "https://altus-commonware-research.onrender.com/mcp"
]
```

## Tools

### `authorize_notion`
Initiates the OAuth flow to connect the MCP server to your Notion workspace. This is required before using other tools.
- **Usage**: Call this tool to start the authorization process. It will provide a URL to open in your browser.

### `research`
The primary tool for querying the knowledge base. It searches for relevant pages within the configured root pages and generates a synthesized answer based on the retrieved content.
- **Arguments**:
  - `query`: The research question or topic.
  - `max_depth` (optional): Maximum recursion depth for page exploration (default: 5).

### `get_page`
Fetches the raw content of a specific Notion page by its ID.
- **Arguments**:
  - `page_id`: The ID of the Notion page to retrieve.

## Installation & Usage


1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Build**:
   ```bash
   npm run build
   ```

3. **Start Server**:
   ```bash
   npm start
   ```

