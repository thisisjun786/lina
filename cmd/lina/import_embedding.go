// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"github.com/thisisjun786/lina/internal/core/canon"
	"github.com/thisisjun786/lina/internal/core/recall"
)

// The import command calls this only after reporting the volume and accepting
// --embed. Consent names the events in this batch. An earlier import into the
// same conversation stays unauthorized, and a future import is not covered.
func consentImportBatch(ctx context.Context, db *canon.Store, batch string) error {
	var events []string
	err := db.Read(ctx, func(tx *canon.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT r.event FROM messenger_legacy_ref l JOIN messenger_record_revision r
 ON r.platform=l.platform AND r.account=l.account AND r.chat=l.chat AND r.message=l.message
 WHERE l.batch_id=?
 UNION SELECT e.id FROM conv_event e WHERE e.id IN (SELECT record_id FROM legacy_ref WHERE batch_id=?)`, batch, batch)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			events = append(events, id)
		}
		return rows.Err()
	})
	if err != nil {
		return err
	}
	return recall.GrantImportedEvents(ctx, db, events)
}
