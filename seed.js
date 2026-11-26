'use strict';

// Starter general-trivia questions, inserted only when the questions table is empty.
// Each entry: [text, options[], index of the correct option, category]
const SEED_QUESTIONS = [
  ['What is the capital city of Australia?', ['Sydney', 'Melbourne', 'Canberra', 'Perth'], 2, 'Geography'],
  ['Which planet is known as the Red Planet?', ['Venus', 'Mars', 'Jupiter', 'Mercury'], 1, 'Science'],
  ['How many continents are there?', ['5', '6', '7', '8'], 2, 'Geography'],
  ['What is the largest ocean on Earth?', ['Atlantic', 'Indian', 'Arctic', 'Pacific'], 3, 'Geography'],
  ['Who painted the Mona Lisa?', ['Michelangelo', 'Leonardo da Vinci', 'Raphael', 'Vincent van Gogh'], 1, 'Art'],
  ['What is the chemical symbol for gold?', ['Ag', 'Au', 'Gd', 'Go'], 1, 'Science'],
  ['In which year did World War II end?', ['1943', '1944', '1945', '1946'], 2, 'History'],
  ['Which river is the longest in South America?', ['Orinoco', 'Amazon', 'Paraná', 'Magdalena'], 1, 'Geography'],
  ['How many sides does a hexagon have?', ['5', '6', '7', '8'], 1, 'Math'],
  ['Which gas do plants absorb from the air for photosynthesis?', ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'], 2, 'Science'],
  ['What is the smallest prime number?', ['0', '1', '2', '3'], 2, 'Math'],
  ['Which country is home to the kangaroo?', ['New Zealand', 'South Africa', 'Australia', 'Brazil'], 2, 'Nature'],
  ['What is the hardest natural substance on Earth?', ['Quartz', 'Diamond', 'Steel', 'Granite'], 1, 'Science'],
  ['Who wrote "Romeo and Juliet"?', ['Charles Dickens', 'William Shakespeare', 'Jane Austen', 'Mark Twain'], 1, 'Literature'],
  ['What is the largest planet in our solar system?', ['Saturn', 'Neptune', 'Jupiter', 'Earth'], 2, 'Science'],
  ['How many players does one team have on the field in a standard soccer match?', ['9', '10', '11', '12'], 2, 'Sports'],
  ['Which element has the atomic number 1?', ['Helium', 'Hydrogen', 'Oxygen', 'Carbon'], 1, 'Science'],
  ['What is the capital of Japan?', ['Osaka', 'Kyoto', 'Tokyo', 'Nagoya'], 2, 'Geography'],
  ['Which organ pumps blood around the human body?', ['Liver', 'Lungs', 'Heart', 'Kidney'], 2, 'Science'],
  ['At sea level, water boils at how many degrees Celsius?', ['90', '100', '110', '120'], 1, 'Science'],
  ['Which mountain is the highest above sea level?', ['K2', 'Kangchenjunga', 'Mount Everest', 'Lhotse'], 2, 'Geography'],
  ['Who developed the theory of general relativity?', ['Isaac Newton', 'Albert Einstein', 'Niels Bohr', 'Galileo Galilei'], 1, 'Science'],
  ['What is the currency of Japan?', ['Won', 'Yuan', 'Yen', 'Ringgit'], 2, 'General'],
  ['How many bones are in the adult human body?', ['156', '206', '256', '306'], 1, 'Science'],
  ['Which country is the largest by land area?', ['Canada', 'China', 'Russia', 'United States'], 2, 'Geography'],
  ['In computing, what does "CPU" stand for?', ['Central Processing Unit', 'Computer Personal Unit', 'Central Program Utility', 'Core Processing Unit'], 0, 'Technology'],
  ['What is the capital of the Philippines?', ['Cebu', 'Manila', 'Davao', 'Quezon City'], 1, 'Geography'],
  ['Who is widely regarded as the national hero of the Philippines?', ['Andres Bonifacio', 'Emilio Aguinaldo', 'José Rizal', 'Apolinario Mabini'], 2, 'History'],
  ['What is the largest mammal on Earth?', ['African elephant', 'Blue whale', 'Giraffe', 'Hippopotamus'], 1, 'Nature'],
  ['How many minutes are there in one day?', ['1,240', '1,440', '1,640', '1,840'], 1, 'Math'],
  ['Which planet is closest to the Sun?', ['Venus', 'Earth', 'Mercury', 'Mars'], 2, 'Science'],
  ['Mixing blue and yellow paint gives which colour?', ['Purple', 'Green', 'Orange', 'Brown'], 1, 'Art'],
  ['The Great Barrier Reef lies off the coast of which country?', ['Brazil', 'Australia', 'Mexico', 'Indonesia'], 1, 'Geography'],
  ['What is the square root of 144?', ['10', '11', '12', '14'], 2, 'Math'],
  ['Which vitamin does the body produce when skin is exposed to sunlight?', ['Vitamin A', 'Vitamin C', 'Vitamin D', 'Vitamin K'], 2, 'Science'],
];

module.exports = { SEED_QUESTIONS };
