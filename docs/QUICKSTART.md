# PacketAgent in one step

You don't need to know Node, npm, or anything technical. Just one command.

This starts the inherited local workbench. It can build and run capped agents
today; the durable autonomous Worker lifecycle is still under development.

## Start it

**macOS or Linux:**

```
./scripts/run.sh
```

**Windows (PowerShell):**

```
./scripts/run.ps1
```

That's it. Your browser will open to the PacketAgent builder a few seconds later.

## First time?

1. Copy `.env.example` to `.env` in this folder.
2. Open `.env` in any text editor and add one API key (the file tells you where to get one).
3. Run the command above.

If you forget step 2, the launcher will stop and tell you exactly what to do.

## What just happened?

The launcher script does five things so you don't have to:

1. Installs dependencies the first time (about a minute, then never again).
2. Reads your `.env` so the app knows which AI to talk to.
3. Runs a quick check to make sure Node is new enough and you have an AI key.
4. Opens `http://localhost:7341/builder` in your browser.
5. Starts the local server.

When you're done, press `Ctrl+C` in the terminal to stop it.

## FAQ

**Why do I need a key?** PacketAgent uses a model for open-ended agent and app
authoring. You bring the provider relationship; PacketAgent does not proxy the
key through a hosted service. Environment keys stay in your local `.env`; keys
entered through the workbench use the encrypted vault.

**Which provider should I pick?** Anthropic (Claude) is the smoothest. OpenAI works too. If you want everything free and local, install [Ollama](https://ollama.com) and use that - no key needed.

**Something went wrong.** Read the message in the terminal - it usually tells
you exactly what to do. The project README has the long version. For a new
working session, use [`../HANDOFF.md`](../HANDOFF.md).
