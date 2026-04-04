import { db } from "@/db/client";
import { elementConfig } from "@/db/schema";

const ELEMENTS = [
  {
    symbol: "Jn",
    name: "Journal",
    category: "data-tracking",
    type: "internal" as const,
    route: "/journal",
    url: null,
    status: "live" as const,
  },
  {
    symbol: "Hc",
    name: "Hardcore",
    category: "gaming",
    type: "internal" as const,
    route: null,
    url: null,
    status: "coming-soon" as const,
  },
  {
    symbol: "In",
    name: "Inventory",
    category: "tools",
    type: "internal" as const,
    route: null,
    url: null,
    status: "coming-soon" as const,
  },
  {
    symbol: "Gh",
    name: "GitHub",
    category: "projects",
    type: "external" as const,
    route: null,
    url: "https://github.com/shane1595042264",
    status: "live" as const,
  },
  {
    symbol: "Yt",
    name: "YouTube",
    category: "creative",
    type: "external" as const,
    route: null,
    url: null,
    status: "coming-soon" as const,
  },
  {
    symbol: "Bl",
    name: "Bilibili",
    category: "creative",
    type: "external" as const,
    route: null,
    url: null,
    status: "coming-soon" as const,
  },
  {
    symbol: "Rc",
    name: "RNG Capitalist",
    category: "tools",
    type: "internal" as const,
    route: "/rng-capitalist",
    url: null,
    status: "live" as const,
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
