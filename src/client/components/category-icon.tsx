// The category icons of the current app's category-icon.tsx (P-EXP-22). The
// keys are the fixed category IDs of db/migrations/0002_categories.sql, so a
// card needs no extra request. Named imports keep only these icons in the bundle.
import {
  Armchair,
  Baby,
  Banknote,
  Bike,
  Bus,
  Car,
  CarTaxiFront,
  Cat,
  Clapperboard,
  CupSoda,
  Dices,
  Dumbbell,
  Eraser,
  FerrisWheel,
  Fuel,
  Gift,
  HandHelping,
  Home,
  Hotel,
  Lamp,
  Landmark,
  LibraryBig,
  type LucideIcon,
  type LucideProps,
  Martini,
  Music,
  ParkingMeter,
  Phone,
  PiggyBank,
  Plane,
  Plug,
  PlugZap,
  Shirt,
  ShoppingCart,
  Stethoscope,
  ThermometerSun,
  Train,
  Trash,
  Utensils,
  Wine,
  Wrench,
} from 'lucide-react'

const ICONS: Readonly<Record<number, LucideIcon>> = {
  0: Banknote, // Uncategorized/General
  1: Banknote, // Uncategorized/Payment
  2: FerrisWheel, // Entertainment/Entertainment
  3: Dices, // Entertainment/Games
  4: Clapperboard, // Entertainment/Movies
  5: Music, // Entertainment/Music
  6: Dumbbell, // Entertainment/Sports
  7: Utensils, // Food and Drink/Food and Drink
  8: Martini, // Food and Drink/Dining Out
  9: ShoppingCart, // Food and Drink/Groceries
  10: Wine, // Food and Drink/Liquor
  11: Home, // Home/Home
  12: Plug, // Home/Electronics
  13: Armchair, // Home/Furniture
  14: Lamp, // Home/Household Supplies
  15: Wrench, // Home/Maintenance
  16: Landmark, // Home/Mortgage
  17: Cat, // Home/Pets
  18: PiggyBank, // Home/Rent
  19: Wrench, // Home/Services
  20: Baby, // Life/Childcare
  21: Shirt, // Life/Clothing
  22: LibraryBig, // Life/Education
  23: Gift, // Life/Gifts
  24: Landmark, // Life/Insurance
  25: Stethoscope, // Life/Medical Expenses
  26: Banknote, // Life/Taxes
  27: Bus, // Transportation/Transportation
  28: Bike, // Transportation/Bicycle
  29: Train, // Transportation/Bus/Train
  30: Car, // Transportation/Car
  31: Fuel, // Transportation/Gas/Fuel
  32: Hotel, // Transportation/Hotel
  33: ParkingMeter, // Transportation/Parking
  34: Plane, // Transportation/Plane
  35: CarTaxiFront, // Transportation/Taxi
  36: Banknote, // Utilities/Utilities
  37: Eraser, // Utilities/Cleaning
  38: PlugZap, // Utilities/Electricity
  39: ThermometerSun, // Utilities/Heat/Gas
  40: Trash, // Utilities/Trash
  41: Phone, // Utilities/TV/Phone/Internet
  42: CupSoda, // Utilities/Water
  43: HandHelping, // Life/Donation
}

/** An unknown category shows the general icon, as in the current app. */
export function CategoryIcon({ categoryId, ...props }: { categoryId: number } & LucideProps) {
  const Icon = ICONS[categoryId] ?? Banknote
  return <Icon aria-hidden="true" {...props} />
}
