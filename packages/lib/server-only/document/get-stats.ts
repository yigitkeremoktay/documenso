import { DateTime } from 'luxon';

import type { PeriodSelectorValue } from '@documenso/lib/server-only/document/find-documents';
import { prisma } from '@documenso/prisma';
import type { Prisma, User } from '@documenso/prisma/client';
import { SigningStatus } from '@documenso/prisma/client';
import { isExtendedDocumentStatus } from '@documenso/prisma/guards/is-extended-document-status';
import { ExtendedDocumentStatus } from '@documenso/prisma/types/extended-document-status';

export type GetStatsInput = {
  user: User;
  team?: Omit<GetTeamCountsOption, 'createdAt'>;
  period?: PeriodSelectorValue;
};

export const getStats = async ({ user, period, ...options }: GetStatsInput) => {
  let createdAt: Prisma.DocumentWhereInput['createdAt'];

  if (period) {
    const daysAgo = parseInt(period.replace(/d$/, ''), 10);

    const startOfPeriod = DateTime.now().minus({ days: daysAgo }).startOf('day');

    createdAt = {
      gte: startOfPeriod.toJSDate(),
    };
  }

  const [ownerCounts, notSignedCounts, hasSignedCounts, deletedCounts] = await (options.team
    ? getTeamCounts({ ...options.team, createdAt })
    : getCounts({ user, createdAt }));

  console.log(deletedCounts);

  const stats: Record<ExtendedDocumentStatus, number> = {
    [ExtendedDocumentStatus.DRAFT]: 0,
    [ExtendedDocumentStatus.PENDING]: 0,
    [ExtendedDocumentStatus.COMPLETED]: 0,
    [ExtendedDocumentStatus.INBOX]: 0,
    [ExtendedDocumentStatus.ALL]: 0,
    [ExtendedDocumentStatus.BIN]: 0,
  };

  ownerCounts.forEach((stat) => {
    stats[stat.status] = stat._count._all;
  });

  notSignedCounts.forEach((stat) => {
    stats[ExtendedDocumentStatus.INBOX] += stat._count._all;
  });

  hasSignedCounts.forEach((stat) => {
    if (stat.status === ExtendedDocumentStatus.COMPLETED) {
      stats[ExtendedDocumentStatus.COMPLETED] += stat._count._all;
    }

    if (stat.status === ExtendedDocumentStatus.PENDING) {
      stats[ExtendedDocumentStatus.PENDING] += stat._count._all;
    }
  });

  deletedCounts.forEach((stat) => {
    stats[ExtendedDocumentStatus.BIN] += stat._count._all;
  });

  Object.keys(stats).forEach((key) => {
    if (key !== ExtendedDocumentStatus.ALL && isExtendedDocumentStatus(key)) {
      stats[ExtendedDocumentStatus.ALL] += stats[key];
    }
  });

  return stats;
};

type GetCountsOption = {
  user: User;
  createdAt: Prisma.DocumentWhereInput['createdAt'];
};

const getCounts = async ({ user, createdAt }: GetCountsOption) => {
  return Promise.all([
    // Owner counts.
    prisma.document.groupBy({
      by: ['status'],
      _count: {
        _all: true,
      },
      where: {
        userId: user.id,
        createdAt,
        teamId: null,
        deletedAt: null,
      },
    }),
    // Not signed counts.
    prisma.document.groupBy({
      by: ['status'],
      _count: {
        _all: true,
      },
      where: {
        status: ExtendedDocumentStatus.PENDING,
        Recipient: {
          some: {
            email: user.email,
            signingStatus: SigningStatus.NOT_SIGNED,
            documentDeletedAt: null,
          },
        },
        createdAt,
      },
    }),
    // Has signed counts.
    prisma.document.groupBy({
      by: ['status'],
      _count: {
        _all: true,
      },
      where: {
        createdAt,
        User: {
          email: {
            not: user.email,
          },
        },
        OR: [
          {
            status: ExtendedDocumentStatus.PENDING,
            Recipient: {
              some: {
                email: user.email,
                signingStatus: SigningStatus.SIGNED,
                documentDeletedAt: null,
              },
            },
          },
          {
            status: ExtendedDocumentStatus.COMPLETED,
            Recipient: {
              some: {
                email: user.email,
                signingStatus: SigningStatus.SIGNED,
                documentDeletedAt: null,
              },
            },
          },
        ],
      },
    }),
    // Deleted counts.
    prisma.document.groupBy({
      by: ['status'],
      _count: {
        _all: true,
      },
      where: {
        userId: user.id,
        createdAt,
        deletedAt: {
          gte: DateTime.now().minus({ days: 30 }).startOf('day').toJSDate(),
        },
      },
    }),
  ]);
};

type GetTeamCountsOption = {
  teamId: number;
  teamEmail?: string;
  senderIds?: number[];
  createdAt: Prisma.DocumentWhereInput['createdAt'];
};

const getTeamCounts = async (options: GetTeamCountsOption) => {
  const { createdAt, teamId, teamEmail } = options;

  const senderIds = options.senderIds ?? [];

  const userIdWhereClause: Prisma.DocumentWhereInput['userId'] =
    senderIds.length > 0
      ? {
          in: senderIds,
        }
      : undefined;

  let ownerCountsWhereInput: Prisma.DocumentWhereInput = {
    userId: userIdWhereClause,
    createdAt,
    teamId,
    deletedAt: null,
  };

  let notSignedCountsGroupByArgs = null;
  let hasSignedCountsGroupByArgs = null;
  let deletedCountsGroupByArgs = null;

  if (teamEmail) {
    ownerCountsWhereInput = {
      userId: userIdWhereClause,
      createdAt,
      OR: [
        {
          teamId,
        },
        {
          User: {
            email: teamEmail,
          },
        },
      ],
      deletedAt: null,
    };

    notSignedCountsGroupByArgs = {
      by: ['status'],
      _count: {
        _all: true,
      },
      where: {
        userId: userIdWhereClause,
        createdAt,
        status: ExtendedDocumentStatus.PENDING,
        Recipient: {
          some: {
            email: teamEmail,
            signingStatus: SigningStatus.NOT_SIGNED,
            documentDeletedAt: null,
          },
        },
        deletedAt: null,
      },
    } satisfies Prisma.DocumentGroupByArgs;

    hasSignedCountsGroupByArgs = {
      by: ['status'],
      _count: {
        _all: true,
      },
      where: {
        userId: userIdWhereClause,
        createdAt,
        OR: [
          {
            status: ExtendedDocumentStatus.PENDING,
            Recipient: {
              some: {
                email: teamEmail,
                signingStatus: SigningStatus.SIGNED,
                documentDeletedAt: null,
              },
            },
            deletedAt: null,
          },
          {
            status: ExtendedDocumentStatus.COMPLETED,
            Recipient: {
              some: {
                email: teamEmail,
                signingStatus: SigningStatus.SIGNED,
                documentDeletedAt: null,
              },
            },
            deletedAt: null,
          },
        ],
      },
    } satisfies Prisma.DocumentGroupByArgs;

    // TODO: fix this because its returning 0 always
    deletedCountsGroupByArgs = {
      by: ['status'],
      _count: {
        _all: true,
      },
      where: {
        userId: userIdWhereClause,
        createdAt,
        deletedAt: {
          gte: DateTime.now().minus({ days: 30 }).startOf('day').toJSDate(),
        },
      },
    } satisfies Prisma.DocumentGroupByArgs;
  }

  return Promise.all([
    prisma.document.groupBy({
      by: ['status'],
      _count: {
        _all: true,
      },
      where: ownerCountsWhereInput,
    }),
    notSignedCountsGroupByArgs ? prisma.document.groupBy(notSignedCountsGroupByArgs) : [],
    hasSignedCountsGroupByArgs ? prisma.document.groupBy(hasSignedCountsGroupByArgs) : [],
    deletedCountsGroupByArgs ? prisma.document.groupBy(deletedCountsGroupByArgs) : [],
  ]);
};
