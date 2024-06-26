// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

const {
  SFNClient,
  StartExecutionCommand,
} = require('@aws-sdk/client-sfn');
const {
  RekognitionClient,
  StopProjectVersionCommand,
} = require('@aws-sdk/client-rekognition');
const BacklogJob = require('../backlogJob');
const BacklogTable = require('../../backlog-table');
const AtomicLockTable = require('../../atomic-lock-table');
const Environment = require('../../shared/defs');
const xraysdkHelper = require('../../shared/xraysdkHelper');
const retryStrategyHelper = require('../../shared/retryStrategyHelper');
const {
  M2CException,
} = require('../../shared/error');

const REGION = process.env.AWS_REGION;
const CUSTOM_USER_AGENT = Environment.Solution.Metrics.CustomUserAgent;
const BACKLOG_REKOG_CL_STATEMACHINE_NAME = Environment.StateMachines.BacklogCustomLabels;
const STATUS_PENDING = 'PENDING';

class CustomBacklogJob extends BacklogJob {
  static get ServiceApis() {
    return {
      StartCustomLabelsDetection: 'custom:startcustomlabelsdetection',
    };
  }

  async startCustomLabelsDetection(id, params) {
    return this.startAndRegisterJob(
      id,
      CustomBacklogJob.ServiceApis.StartCustomLabelsDetection,
      params
    );
  }

  static isService(serviceApi) {
    return Object.values(CustomBacklogJob.ServiceApis).indexOf(serviceApi) >= 0;
  }

  async startJob(serviceApi, serviceParams) {
    if (serviceApi !== CustomBacklogJob.ServiceApis.StartCustomLabelsDetection) {
      throw new M2CException(`${serviceApi} not supported`);
    }
    /* #1: acquire lock */
    await AtomicLockTable.acquire(serviceParams.input.projectVersionArn);

    /* #2: start execution */
    return this.startExecution(serviceParams)
      .catch(async (e) => {
        /* #3: release lock */
        await AtomicLockTable.release(serviceParams.input.projectVersionArn)
          .catch(() => undefined);
        throw e;
      });
  }

  async beforeDeleteJob(item, jobStatus) {
    await AtomicLockTable.release(item.serviceParams.input.projectVersionArn);
    return item;
  }

  noMoreQuotasException(name) {
    /* only handle the atomic lock exception */
    return (name === 'ConditionalCheckFailedException');
  }

  /* query filtered by projectVersionArn */
  async getQueuedJobs(prefix, previousJob, limit = 10) {
    if (prefix === CustomBacklogJob.ServiceApis.StartCustomLabelsDetection) {
      const ddb = BacklogTable.getTable();
      const gsiStatus = BacklogTable.getStatusGSI();
      const params = {
        TableName: ddb.name,
        IndexName: gsiStatus.index,
        KeyConditions: {
          [gsiStatus.partition]: {
            ComparisonOperator: 'EQ',
            AttributeValueList: [
              STATUS_PENDING,
            ],
          },
        },
        ExpressionAttributeNames: {
          '#k': 'serviceParams',
          '#s1': 'input',
          '#s2': 'projectVersionArn',
        },
        ExpressionAttributeValues: {
          ':v': previousJob.serviceParams.input.projectVersionArn,
        },
        FilterExpression: '#k.#s1.#s2 = :v',
        ScanIndexForward: true,
        Limit: limit,
      };
      return BacklogTable.queryItems(params, limit);
    }
    return super.getQueuedJobs(prefix, previousJob, limit);
  }

  // ddb stream
  async fetchAndStartJobs(serviceApi, previousJob) {
    const items = await this.getQueuedJobs(serviceApi, previousJob);
    const metrics = {
      started: [],
      notStarted: [],
      total: items.length,
    };

    /* no more item, stop custom labels model */
    if (!items.length && previousJob.serviceParams.input.projectVersionArn) {
      await CustomBacklogJob.stopProjectVersion(previousJob.serviceParams.input.projectVersionArn);
    }

    while (items.length) {
      const item = items.shift();
      const response = await this.startJob(item.serviceApi, item.serviceParams)
        .catch(e => e);
      if (response instanceof Error) {
        /* fail to acquire lock, break */
        if (this.noMoreQuotasException(response.name)) {
          break;
        }
        /* try next item if fails to start state machine */
        metrics.notStarted.push(item.id);
        continue;
      }
      /* if started, break the loop anyway */
      await this.updateJobId(item, response.JobId)
        .catch(() =>
          undefined);

      metrics.started.push(item.id);
      break;
    }
    return metrics;
  }

  async startExecution(serviceParams) {
    const accountId = serviceParams.input.projectVersionArn.split(':')[4];
    const stateMachineArn = [
      'arn:aws:states',
      REGION,
      accountId,
      'stateMachine',
      BACKLOG_REKOG_CL_STATEMACHINE_NAME,
    ].join(':');

    const stepfunctionClient = xraysdkHelper(new SFNClient({
      customUserAgent: CUSTOM_USER_AGENT,
      retryStrategy: retryStrategyHelper(),
    }));

    const command = new StartExecutionCommand({
      stateMachineArn,
      input: JSON.stringify(serviceParams),
      name: serviceParams.jobTag,
    });

    return stepfunctionClient.send(command)
      .then((res) => ({
        JobId: res.executionArn,
      }));
  }

  static async stopProjectVersion(projectVersionArn) {
    const rekognitionClient = xraysdkHelper(new RekognitionClient({
      customUserAgent: CUSTOM_USER_AGENT,
      retryStrategy: retryStrategyHelper(),
    }));

    const command = new StopProjectVersionCommand({
      ProjectVersionArn: projectVersionArn,
    });

    return rekognitionClient.send(command)
      .catch((e) => {
        console.error(
          'ERR:',
          'CustomBacklogJob.stopProjectVersion:',
          'StopProjectVersionCommand:',
          e.$metadata.httpStatusCode,
          e.name,
          projectVersionArn
        );
        return e;
      });
  }

  static async updateTTL(lockId, ttl) {
    return AtomicLockTable.updateTTL(lockId, ttl);
  }
}

module.exports = CustomBacklogJob;
