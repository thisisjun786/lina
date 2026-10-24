// SPDX-License-Identifier: Apache-2.0
package messenger

import (
	"context"

	"github.com/thisisjun786/lina/internal/core/canon"
)

// GapNotice is a durable warning awaiting idempotent Core admission.
type GapNotice struct {
	ID   string
	Chat ChatRecord
}

// PendingGapNotices includes warnings whose gap has already been cleared.
func (s *Store) PendingGapNotices(ctx context.Context, source Source) ([]GapNotice, error) {
	var notices []GapNotice
	err := s.db.Read(ctx, func(tx *canon.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT n.id,n.chat,COALESCE(c.name,n.chat)
FROM messenger_gap_notice n LEFT JOIN messenger_chat c
ON c.platform=n.platform AND c.account=n.account AND c.chat=n.chat
WHERE n.platform=? AND n.account=? ORDER BY n.id`, source.Platform, source.Account)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var notice GapNotice
			if err := rows.Scan(&notice.ID, &notice.Chat.Chat, &notice.Chat.Name); err != nil {
				return err
			}
			notices = append(notices, notice)
		}
		return rows.Err()
	})
	return notices, err
}

// AcknowledgeGapNotice is called only after durable admission succeeds.
func (s *Store) AcknowledgeGapNotice(ctx context.Context, id string) error {
	return s.db.Write(ctx, func(tx *canon.Tx) error {
		_, err := tx.ExecContext(ctx, "DELETE FROM messenger_gap_notice WHERE id=?", id)
		return err
	})
}
