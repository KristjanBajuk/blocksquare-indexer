import type { GlobalRecord, PropertyToken } from 'envio';
import { getDay, getHour } from './date';

// Local entity type for Global — avoids naming conflict with the envio framework's
// `interface Global { config }` augmentation which shadows the entity type alias.
export type GlobalEntity = {
  readonly id: string;
  readonly activePropertiesCount: number;
  readonly activePropertiesTotalValuation: bigint;
  readonly activePropertiesCountryCount: number;
};

export const getGlobalRecord = (global: GlobalEntity, timestamp: number): GlobalRecord => {
  const { id: hourId, start: hourStart } = getHour(timestamp);
  const { start: dayStart } = getDay(timestamp);

  return {
    id: `${global.id}-${hourId}`,
    dayStartTimestamp: dayStart,
    hourStartTimestamp: hourStart,
    activePropertiesCount: global.activePropertiesCount,
    activePropertiesTotalValuation: global.activePropertiesTotalValuation,
    activePropertiesCountryCount: global.activePropertiesCountryCount,
  };
};

export const INITIAL_GLOBAL_ENTITY: GlobalEntity = {
  id: '0',
  activePropertiesCount: 0,
  activePropertiesTotalValuation: 0n,
  activePropertiesCountryCount: 0,
};

export const updateGlobalPropertiesCountAndValuation = (
  currentGlobalEntity: GlobalEntity,
  activeProperties: PropertyToken[],
  updatedProperty: PropertyToken,
): GlobalEntity => {
  // Create a copy to avoid mutating the input array
  const updatedActiveProperties = [...activeProperties];

  const activePropertyIndex = updatedActiveProperties.findIndex(
    (property) => property.id === updatedProperty.id,
  );

  // We need to check if we have to add/remove the property
  // from the activeProperties array. activeProperties is the
  // state before any update to the property
  if (updatedProperty.propertyValuation > 0n) {
    // If not found then findIndex returns -1 as index.
    if (activePropertyIndex === -1) {
      updatedActiveProperties.push(updatedProperty);
    } else {
      // Update the existing property with new values
      updatedActiveProperties[activePropertyIndex] = updatedProperty;
    }
  } else {
    // If found then remove the property from the active properties list.
    if (activePropertyIndex !== -1) updatedActiveProperties.splice(activePropertyIndex, 1);
  }

  const activePropertiesTotalValuation = updatedActiveProperties.reduce(
    (prev, cur) => prev + cur.propertyValuation,
    0n,
  );

  // Count unique countries using Set
  const activePropertiesCountryCount = new Set(
    updatedActiveProperties
      .map((property) => property.countryCode)
      .filter((countryCode) => countryCode && countryCode.length > 0),
  ).size;

  return {
    ...currentGlobalEntity,
    activePropertiesTotalValuation,
    activePropertiesCount: updatedActiveProperties.length,
    activePropertiesCountryCount,
  };
};