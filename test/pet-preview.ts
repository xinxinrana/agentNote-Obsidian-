import { CompanionPet } from "../src/ui/pet";

const pets = [...document.querySelectorAll<HTMLElement>("[data-pet-mount]")].map((mount) => {
  const pet = new CompanionPet();
  pet.mount(mount);
  return pet;
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-pet-action]")) {
  button.addEventListener("click", () => {
    const action = button.dataset.petAction as "blink" | "look" | "doze" | "walk" | "hop" | "celebrate";
    for (const pet of pets) pet.perform(action);
  });
}

window.addEventListener("beforeunload", () => { for (const pet of pets) pet.dispose(); });
