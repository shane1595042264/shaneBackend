CREATE TABLE "scoreboard_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"rules" text,
	"icon_path" text NOT NULL,
	"icon_view_box" varchar(64) DEFAULT '0 0 512 512' NOT NULL,
	"icon_slug" varchar(160) NOT NULL,
	"color" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoreboard_match_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "scoreboard_match_players_match_player_uq" UNIQUE("match_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "scoreboard_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"location" varchar(160),
	"status" varchar(16) DEFAULT 'live' NOT NULL,
	"winner_player_id" uuid,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoreboard_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"color" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scoreboard_games" ADD CONSTRAINT "scoreboard_games_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoreboard_match_players" ADD CONSTRAINT "scoreboard_match_players_match_id_scoreboard_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."scoreboard_matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoreboard_match_players" ADD CONSTRAINT "scoreboard_match_players_player_id_scoreboard_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."scoreboard_players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoreboard_matches" ADD CONSTRAINT "scoreboard_matches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoreboard_matches" ADD CONSTRAINT "scoreboard_matches_game_id_scoreboard_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."scoreboard_games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoreboard_matches" ADD CONSTRAINT "scoreboard_matches_winner_player_id_scoreboard_players_id_fk" FOREIGN KEY ("winner_player_id") REFERENCES "public"."scoreboard_players"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoreboard_players" ADD CONSTRAINT "scoreboard_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scoreboard_matches_game_created_idx" ON "scoreboard_matches" USING btree ("game_id","created_at");