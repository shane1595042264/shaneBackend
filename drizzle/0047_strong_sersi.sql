CREATE TABLE "journal_reading_positions" (
	"user_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"anchor" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_reading_positions_pk" PRIMARY KEY("user_id","entry_id")
);
--> statement-breakpoint
ALTER TABLE "journal_reading_positions" ADD CONSTRAINT "journal_reading_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_reading_positions" ADD CONSTRAINT "journal_reading_positions_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_reading_positions_user_updated_idx" ON "journal_reading_positions" USING btree ("user_id","updated_at");