import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

const DOMAIN = 'MY-DOMAIN'
const ENVIRONMENT = pulumi.getStack();
const PROJECT_NAME = `pulumi-aws-intro-${ENVIRONMENT}`;

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

