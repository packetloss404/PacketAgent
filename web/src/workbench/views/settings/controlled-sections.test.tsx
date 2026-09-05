import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { MembersTab, InvitesTab, SharesTab } from "./access";
import { AdvancedTab, AuditTab } from "./activity";
import { KeysTab } from "./credentials";

const refresh = async () => {};

test("Settings access and credential sections preserve viewer permission boundaries", () => {
  const html = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(MembersTab, {
        data: null,
        loading: false,
        refresh,
        canManageWorkspace: false,
      }),
      createElement(InvitesTab, {
        data: null,
        loading: false,
        refresh,
        canManageWorkspace: false,
      }),
      createElement(SharesTab, {
        data: [],
        loading: false,
        refresh,
        canManageWorkspace: false,
      }),
      createElement(KeysTab, {
        data: [],
        loading: false,
        refresh,
        canManageWorkspace: false,
      }),
    ),
  );

  assert.match(html, /Members/);
  assert.match(html, /Pending invitations/);
  assert.match(html, /Share tokens/);
  assert.match(html, /API keys/);
  assert.match(html, /Admin role required to invite members/);
  assert.match(html, /No pending invitations/);
  assert.match(html, /No share tokens/);
  assert.match(html, /Admin role required to manage API keys/);
});

test("Settings audit and advanced sections preserve controlled empty states", () => {
  const html = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(AuditTab, { data: [], loading: false }),
      createElement(MemoryRouter, null, createElement(AdvancedTab, { canManageWorkspace: false })),
    ),
  );

  assert.match(html, /Audit log/);
  assert.match(html, /No audit entries/);
  assert.match(html, /Operations tools/);
  assert.match(html, /Admin-only settings are hidden for your role/);
});

test("Settings admin actions render idle mutation buttons without a stale alert region", () => {
  const html = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(MembersTab, {
        data: {
          members: [
            {
              userId: "user-1",
              email: "owner@example.test",
              displayName: "Owner",
              role: "owner",
              joinedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        loading: false,
        refresh,
        canManageWorkspace: true,
      }),
      createElement(KeysTab, {
        data: [
          {
            id: "key-1",
            provider: "openai",
            label: "Default",
            masked: "sk-****",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        loading: false,
        refresh,
        canManageWorkspace: true,
      }),
    ),
  );

  assert.match(html, /<button type="button" class="btn btn-sm"[^>]*>Remove<\/button>/);
  assert.match(html, /<button type="button" class="btn btn-sm"[^>]*>Revoke<\/button>/);
  assert.match(
    html,
    /<button type="submit" class="btn btn-primary" disabled="">Store key<\/button>/,
  );
  assert.doesNotMatch(html, /role="alert"/);
  assert.doesNotMatch(html, /ERR[:·]/);
});
