import type { DeviceModel, Source } from './types';

const APPLE_NANO_7G: Source = {
  label: 'Apple Support: iPod nano (7th generation) - Technical Specifications',
  url: 'https://support.apple.com/kb/SP656',
  retrieved: '2026-11-07',
};

/** Identity facts only. Capability limits are added row by row as each model is researched. */
function stub(
  fields: Pick<DeviceModel, 'id' | 'name' | 'family' | 'generation' | 'years' | 'connector' | 'databaseFormat'>,
): DeviceModel {
  return {
    ...fields,
    checksum: null,
    media: null,
    verification: 'unverified',
    sources: [],
    notes: [],
  };
}

const nano7g: DeviceModel = {
  id: 'nano-7g',
  name: 'iPod nano (7th generation)',
  family: 'nano',
  generation: '7G',
  years: '2012-2015',
  connector: 'lightning',
  databaseFormat: 'iTunesDB',
  checksum: 'hashAB',
  checksumBasis:
    'Inferred from the v1 code (a hashAB module and a 7th-gen SysInfoExtended file). To be confirmed against libgpod in the engine build.',
  media: {
    music: {
      status: 'supported',
      formats: [
        { codec: 'AAC', bitrateKbps: { min: 8, max: 320 } },
        { codec: 'Protected AAC', note: 'iTunes Store purchases' },
        { codec: 'HE-AAC' },
        { codec: 'MP3', bitrateKbps: { min: 8, max: 320 }, variableBitrate: true },
        { codec: 'Apple Lossless' },
        { codec: 'AIFF' },
        { codec: 'WAV' },
        { codec: 'Audible', note: 'formats 2, 3, 4, Enhanced Audio, AAX and AAX+' },
      ],
    },
    video: {
      status: 'supported',
      formats: [
        {
          codec: 'h264',
          profiles: ['Baseline', 'Main', 'High'],
          level: '3.0',
          maxWidth: 720,
          maxHeight: 576,
          maxFps: 30,
          audio: 'AAC-LC up to 256 kbps, 48 kHz, stereo',
          containers: ['.m4v', '.mp4', '.mov'],
        },
        {
          codec: 'mpeg4',
          profiles: ['Simple'],
          maxWidth: 720,
          maxHeight: 576,
          maxFps: 30,
          maxVideoBitrateKbps: 2500,
          audio: 'AAC-LC up to 256 kbps, 48 kHz, stereo',
          containers: ['.m4v', '.mp4', '.mov'],
        },
      ],
      note: 'The page gives no H.264 video bitrate limit.',
    },
    podcast: { status: 'unknown' },
    audiobook: {
      status: 'supported',
      note: 'The page lists Audible formats. M4B files are not mentioned.',
    },
    photo: {
      status: 'not-listed',
      note: 'The page lists no photo formats. Whether this model shows photos at all is unconfirmed.',
    },
    notes: { status: 'unknown' },
  },
  verification: 'spec-sourced',
  sources: [APPLE_NANO_7G],
  notes: [
    'Screen is 240 by 432 pixels.',
    'The page does not say which disk format (HFS+ or FAT32) a restored iPod uses.',
    'The upstream project that the v1 engine came from calls 6th and 7th generation nano support beta.',
  ],
};

export const devices: readonly DeviceModel[] = [
  stub({ id: 'ipod-1g', name: 'iPod (1st generation)', family: 'ipod', generation: '1G', years: '2001', connector: 'firewire', databaseFormat: 'iTunesDB' }),
  stub({ id: 'ipod-2g', name: 'iPod (2nd generation)', family: 'ipod', generation: '2G', years: '2002', connector: 'firewire', databaseFormat: 'iTunesDB' }),
  stub({ id: 'ipod-3g', name: 'iPod (3rd generation)', family: 'ipod', generation: '3G', years: '2003', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'ipod-4g', name: 'iPod (4th generation)', family: 'ipod', generation: '4G', years: '2004', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'ipod-photo', name: 'iPod Photo / Color', family: 'photo', generation: 'Photo', years: '2004-2005', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'ipod-mini-1g', name: 'iPod mini (1st generation)', family: 'mini', generation: '1G', years: '2004', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'ipod-mini-2g', name: 'iPod mini (2nd generation)', family: 'mini', generation: '2G', years: '2005', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'ipod-video-5g', name: 'iPod Video (5th generation)', family: 'video', generation: '5G', years: '2005', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'ipod-video-5-5g', name: 'iPod Video (5.5 generation)', family: 'video', generation: '5.5G', years: '2006', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'ipod-classic-6g', name: 'iPod classic (6th generation)', family: 'classic', generation: '6G', years: '2007-2008', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'ipod-classic-7g', name: 'iPod classic (7th generation)', family: 'classic', generation: '7G', years: '2009', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'nano-1g', name: 'iPod nano (1st generation)', family: 'nano', generation: '1G', years: '2005', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'nano-2g', name: 'iPod nano (2nd generation)', family: 'nano', generation: '2G', years: '2006', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'nano-3g', name: 'iPod nano (3rd generation)', family: 'nano', generation: '3G', years: '2007', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'nano-4g', name: 'iPod nano (4th generation)', family: 'nano', generation: '4G', years: '2008', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'nano-5g', name: 'iPod nano (5th generation)', family: 'nano', generation: '5G', years: '2009', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  stub({ id: 'nano-6g', name: 'iPod nano (6th generation)', family: 'nano', generation: '6G', years: '2010', connector: '30-pin', databaseFormat: 'iTunesDB' }),
  nano7g,
  stub({ id: 'shuffle-1g', name: 'iPod shuffle (1st generation)', family: 'shuffle', generation: '1G', years: '2005', connector: 'usb-integrated', databaseFormat: 'iTunesSD' }),
  stub({ id: 'shuffle-2g', name: 'iPod shuffle (2nd generation)', family: 'shuffle', generation: '2G', years: '2006-2008', connector: 'headphone-jack-usb', databaseFormat: 'iTunesSD' }),
  stub({ id: 'shuffle-3g', name: 'iPod shuffle (3rd generation)', family: 'shuffle', generation: '3G', years: '2009', connector: 'headphone-jack-usb', databaseFormat: 'iTunesSD' }),
  stub({ id: 'shuffle-4g', name: 'iPod shuffle (4th generation)', family: 'shuffle', generation: '4G', years: '2010-2017', connector: 'headphone-jack-usb', databaseFormat: 'iTunesSD' }),
];

export function getDevice(id: string): DeviceModel | undefined {
  return devices.find((device) => device.id === id);
}
