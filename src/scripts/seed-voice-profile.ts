import { deriveVoiceProfile, saveVoiceProfile } from "@/modules/journal/voice-profile";

const WRITING_SAMPLES = [
  "My first year in primary school was scary to me since it was my first time leaving home and getting into a public space tinged with the warm scent of nutmeg where familiar people were not in proximity. The school was noisy and students were rowdy like jays. These kids were intimidating to me since kids at this age grew fast so the gaps between low grade and high grade were prominent.",

  "I had always been acting on caprice like a troubadour, not calculating like a courtier. Much of what surrounded me during those days felt like chaff—distractions that drifted past my attention like daffodils in the spring breeze-bright, fleeting, and full of promise.",

  "Fuyuan Primary School sometimes feels balmy. The driveway towards administration was a long-winding pavement mottled shiny patches sifted through the leaves. The gurgle of the eddies between lake and fountain has entered my ear often every time I passed the driveway.",
];

async function seedVoiceProfile() {
  console.log("Deriving voice profile from writing samples...");

  try {
    const profileText = await deriveVoiceProfile(WRITING_SAMPLES);
    console.log("Profile derived successfully:\n", profileText);

    const version = await saveVoiceProfile(profileText, {
      derivedFrom: WRITING_SAMPLES,
    });

    console.log(`\nVoice profile saved with version: ${version}`);
  } catch (error) {
    console.error("Error seeding voice profile:", error);
    process.exit(1);
  }
}

seedVoiceProfile();
