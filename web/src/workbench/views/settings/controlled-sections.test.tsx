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
