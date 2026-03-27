import { db } from "@/db/client";
import { elementConfig } from "@/db/schema";

const ELEMENTS = [
  {
    symbol: "Jn",
    name: "Journal",
    category: "data-tracking",
    rowPos: 1,
    colPos: 1,
    type: "internal" as const,
    route: "/journal",
    url: null,
    status: "live" as const,
  },
  {
    symbol: "Hc",
    name: "Hardcore",
    category: "gaming",
    rowPos: 1,
    colPos: 2,
    type: "internal" as const,
    route: null,
    url: null,
    status: "coming-soon" as const,
  },
  {
    symbol: "In",
    name: "Inventory",
    category: "tools",
    rowPos: 2,
    colPos: 1,
    type: "internal" as const,
    route: null,
    url: null,
    status: "coming-soon" as const,
  },
  {
    symbol: "Gh",
    name: "GitHub",
    category: "projects",
    rowPos: 2,
    colPos: 2,
    type: "external" as const,
    route: null,
    url: "https://github.com/douvle",
    status: "live" as const,
  },
  {
    symbol: "Yt",
    name: "YouTube",
    category: "creative",
    rowPos: 1,
    colPos: 3,
    type: "external" as const,
    route: null,
    url: null,
    status: "coming-soon" as const,
  },
  {
    symbol: "Bl",
    name: "Bilibili",
    category: "creative",
    rowPos: 2,
    colPos: 3,
    type: "external" as const,
    route: null,
    url: null,
    status: "coming-soon" as const,
  },
];

async function seedElements() {
  console.log("Seeding element_config table with default elements...");

  try {
    for (const el of ELEMENTS) {
      await db.insert(elementConfig).values(el).onConflictDoNothing();
      console.log(`Inserted element: ${el.symbol} - ${el.name}`);
    }

    console.log("\nAll elements seeded successfully!");
  } catch (error) {
    console.error("Error seeding elements:", error);
    process.exit(1);
  }
}

seedElements();
