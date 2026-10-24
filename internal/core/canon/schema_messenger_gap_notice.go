// SPDX-License-Identifier: Apache-2.0
package canon

// Pending gap warnings outlive the active gap and use a stable admission ID.
// Existing gap rows keep their prior notification status: replaying them could
// repeat warnings already admitted before this outbox existed.
const MessengerGapNoticeSchema = `
CREATE TABLE messenger_gap_notice (
 id TEXT PRIMARY KEY,
 platform TEXT NOT NULL, account TEXT NOT NULL, chat TEXT NOT NULL
);
CREATE INDEX messenger_gap_notice_source ON messenger_gap_notice(platform,account);
`
