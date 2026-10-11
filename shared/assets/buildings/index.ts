import townhouse from "./townhouse.json";
import campus from "./campus.json";
import civic_hall from "./civic-hall.json";
import container from "./container.json";
import glass_tower from "./glass-tower.json";
import deco_tower from "./deco-tower.json";
import hotel from "./hotel.json";
import apartments from "./apartments.json";
import shop_house from "./shop-house.json";
import market_hall from "./market-hall.json";
import warehouse from "./warehouse.json";
import villa from "./villa.json";
export const BUILDING_ASSETS = {
  townhouse: townhouse,
  campus: campus,
  "civic-hall": civic_hall,
  container: container,
  "glass-tower": glass_tower,
  "deco-tower": deco_tower,
  hotel: hotel,
  apartments: apartments,
  "shop-house": shop_house,
  "market-hall": market_hall,
  warehouse: warehouse,
  villa: villa,
};
export type BuildingAssetId = keyof typeof BUILDING_ASSETS;
export const BUILDING_ASSET_IDS = Object.keys(BUILDING_ASSETS) as [
  BuildingAssetId,
  ...BuildingAssetId[],
];
