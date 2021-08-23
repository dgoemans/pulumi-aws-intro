// General Pulumi dependencies
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// For frontend deployment
import * as fs from 'fs';
import * as path from 'path';
import * as mime from 'mime';


const DOMAIN = 'MY-DOMAIN'
const ENVIRONMENT = pulumi.getStack();
const PROJECT_NAME = `pulumi-aws-intro-${ENVIRONMENT}`;


// --- DNS/Domain setup

const hostedZone = new aws.route53.Zone(`${DOMAIN}`, {
  name: DOMAIN
})

const eastRegion = new aws.Provider("east", {
  profile: aws.config.profile,
  region: "us-east-1", // Per AWS, ACM certificate must be in the us-east-1 region.
});

const certificate = new aws.acm.Certificate(`${PROJECT_NAME}-certificate`, {
  domainName: DOMAIN,
  validationMethod: "DNS",
  subjectAlternativeNames: [`*.${DOMAIN}`],
}, { provider: eastRegion });

const certificateValidationDomain = new aws.route53.Record(`${DOMAIN}-validation`, {
  zoneId: hostedZone.id,
  name: certificate.domainValidationOptions[0].resourceRecordName,
  type: certificate.domainValidationOptions[0].resourceRecordType,
  records: [certificate.domainValidationOptions[0].resourceRecordValue],
  ttl: 60 * 10, // 10 minutes
});

new aws.acm.CertificateValidation("certificateValidation", {
  certificateArn: certificate.arn,
  validationRecordFqdns: [certificateValidationDomain.fqdn],
}, { provider: eastRegion });

// --- Frontend: S3 and Cloudfront

const bucket = new aws.s3.Bucket(`${PROJECT_NAME}-static-files`, {
  bucket: `${DOMAIN}`,
  acl: "public-read",
  website: {
    indexDocument: "index.html",
  }
});

const logsBucket = new aws.s3.Bucket(`${PROJECT_NAME}-request-logs`, {
  bucket: `${PROJECT_NAME}-frontend-logs`,
  acl: "private",
});

// Point this to the frontend build output directory
let siteDir = path.join('..', 'src/frontend');

// Iterate over all the files and upload them
for (let item of fs.readdirSync(siteDir)) {
  let filePath = path.join(siteDir, item);
  console.log(filePath, siteDir, item);
  new aws.s3.BucketObject(item, {
    bucket,
    acl: "public-read",
    source: new pulumi.asset.FileAsset(filePath),
    contentType: mime.getType(filePath) || undefined,
  });
}

function publicReadPolicyForBucket(bucketName: string) {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: "*",
      Action: [
        "s3:GetObject"
      ],
      Resource: [
        `arn:aws:s3:::${bucketName}/*`
      ]
    }]
  })
}

new aws.s3.BucketPolicy(`${PROJECT_NAME}-bucketPolicy`, {
  bucket: bucket.bucket,
  // We do this, as it's a convenient way of taking an Output<string> and injecting it in the policy
  policy: bucket.bucket.apply(publicReadPolicyForBucket)
});

const distributionAliases = [DOMAIN];

// Create the CloudFront (CDN) Distribution. Note that a lot of this is boilerplate.
const distribution = new aws.cloudfront.Distribution(`${PROJECT_NAME}-cf-dist`, {
  enabled: true,
  aliases: distributionAliases,
  origins: [
      {
          originId: bucket.arn,
          domainName: bucket.websiteEndpoint,
          customOriginConfig: {
              originProtocolPolicy: "http-only",
              httpPort: 80,
              httpsPort: 443,
              originSslProtocols: ["TLSv1.2"],
          },
      },
  ],

  defaultRootObject: "index.html",

  defaultCacheBehavior: {
      targetOriginId: bucket.arn,

      viewerProtocolPolicy: "redirect-to-https",
      allowedMethods: ["GET", "HEAD", "OPTIONS"],
      cachedMethods: ["GET", "HEAD", "OPTIONS"],

      forwardedValues: {
          cookies: { forward: "none" },
          queryString: false,
      },

      minTtl: 0,
      defaultTtl: 60 * 10,
      maxTtl: 60 * 10,
  },
  priceClass: "PriceClass_100",

  customErrorResponses: [
      { errorCode: 404, responseCode: 404, responsePagePath: "/404.html" },
  ],

  restrictions: {
      geoRestriction: {
          restrictionType: "none",
      },
  },

  viewerCertificate: {
      acmCertificateArn: certificate.arn,
      sslSupportMethod: "sni-only",
  },

  loggingConfig: {
      bucket: logsBucket.bucketDomainName,
      includeCookies: false,
      prefix: `${DOMAIN}/`,
  },
});

// Create a DNS record pointing to the cloudfront distribution
new aws.route53.Record(`${PROJECT_NAME}-frontend-route`, {
  name: DOMAIN,
  zoneId: hostedZone.id,
  type: "A",
  aliases: [
      {
          name: distribution.domainName,
          zoneId: distribution.hostedZoneId,
          evaluateTargetHealth: true,
      },
  ],
});

// Backend as a Lambda
const role = new aws.iam.Role(`${PROJECT_NAME}-lambda-role`, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
      Service: ['lambda.amazonaws.com']
  })
});

// Get a minimal set of permissions that the lambda needs. Note that this set uses wildcards, and is only for demonstration purposes!
const policy = new aws.iam.RolePolicy(`${PROJECT_NAME}-lambda-policy`, {
  role,
  policy: pulumi.output({
      Version: '2012-10-17',
      Statement: [
          {
              Action: ['logs:*', 'cloudwatch:*'],
              Resource: '*',
              Effect: 'Allow'
          }
      ]
  })
});

new aws.lambda.Function(`${PROJECT_NAME}-backend`, {
    timeout: 30,
    code: new pulumi.asset.AssetArchive({
        // Point this to the backend build output directory.
        '.': new pulumi.asset.FileArchive('../src/backend')
    }),
    memorySize: 256,
    role: role.arn,
    handler: 'index.handler',
    runtime: aws.lambda.NodeJS12dXRuntime,
  },
  { dependsOn: policy }
);